import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';

import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';

import type { SbxCli } from '../transport/sbx-cli.js';

import { SBX_SANDBOX_PROVIDER_ID } from '../provider-id.js';

type Transformations = ReadonlyArray<HarnessV1RequestTransformation>;

/**
 * Keeps credentials out of the sandbox: each request transformation becomes a custom secret of the
 * Docker Sandboxes proxy, scoped to the sandbox, so the real value only exists on this host and in
 * the proxy.
 */
export interface CredentialBroker {
  add(transformations: Transformations): Promise<void>;
  /** Withdraws the secrets this broker registered. */
  release(): Promise<void>;
  /** Withdraws every secret scoped to the sandbox, a previous process's included. */
  clear(): Promise<void>;
}

/** A custom secret of the Docker Sandboxes proxy, as `sbx secret ls --json` lists it. */
interface CustomSecret {
  placeholder: string;
  scope: string;
}

/**
 * Local sandboxes: the proxy swaps one string for another in the requests to the host. The
 * sandbox sends the harness's placeholder, `Bearer <placeholder>`, and the proxy puts the secret
 * in its place: only the part that differs is registered.
 *
 * A header the request does not carry, the proxy cannot add. When the same transformation does
 * protect a credential, such a header is left out with a warning: Codex, logged in with ChatGPT,
 * asks for a `ChatGPT-Account-ID` its backend does without. A transformation that would protect
 * no credential at all is refused.
 */
export function placeholderBroker(cli: SbxCli, sandbox: string): CredentialBroker {
  const placeholders = new Set<string>();
  const remove = (placeholder: string) =>
    cli.run(['secret', 'rm', '--sandbox', sandbox, '--placeholder', placeholder, '--force']);

  return {
    add: async (transformations) => {
      for (const { match, header, secret } of swappableHeaders(transformations)) {
        const [placeholder, value] = placeholderOf(match, header, secret);
        await cli.check([
          'secret',
          'set-custom',
          '--sandbox',
          sandbox,
          '--host',
          match.host,
          '--placeholder',
          placeholder,
          // On this host's command line for as long as `sbx` runs, never inside the sandbox.
          '--value',
          value,
        ]);
        placeholders.add(placeholder);
      }
    },
    release: async () => {
      for (const placeholder of placeholders) await remove(placeholder);
      placeholders.clear();
    },
    clear: async () => {
      const listed = await cli.check(['secret', 'ls', '--sandbox', sandbox, '--json']);
      const { custom_secrets: secrets = [] } = JSON.parse(listed) as {
        custom_secrets?: CustomSecret[];
      };
      for (const { scope, placeholder } of secrets) {
        if (scope === sandbox) await remove(placeholder);
      }
      placeholders.clear();
    },
  };
}

/**
 * How many views of one sandbox (`fork()`) hold each named secret of a cloud sandbox: a view that
 * releases a secret another one still holds leaves it to the proxy.
 */
export type SecretHolders = Map<string, number>;

/**
 * Cloud sandboxes: the proxy sets the whole header on the requests to the host, whatever the
 * sandbox sent in it. Each secret is named after the sandbox, the host and the header, so
 * registering it again replaces it rather than piling up. The views of one sandbox share these
 * names, counted in `holders`: the last view to release a secret withdraws it.
 */
export function headerBroker(
  cli: SbxCli,
  sandbox: string,
  holders: SecretHolders = new Map(),
): CredentialBroker {
  const names = new Set<string>();
  const remove = (name: string) => cli.run(['secret', 'rm', name, '--force']);

  const release = async (): Promise<void> => {
    for (const name of names) {
      const held = (holders.get(name) ?? 1) - 1;
      if (held > 0) holders.set(name, held);
      else {
        holders.delete(name);
        await remove(name);
      }
    }
    names.clear();
  };
  return {
    add: async (transformations) => {
      for (const { match, header, secret } of headersOf(transformations)) {
        const name = `${sandbox}-${match.host}-${header}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        await cli.check([
          'secret',
          'set-custom',
          '--sandbox',
          sandbox,
          '--name',
          name,
          '--host',
          match.host,
          '--header',
          header,
          '--format',
          '%s',
          '--value',
          secret,
        ]);
        if (!names.has(name)) holders.set(name, (holders.get(name) ?? 0) + 1);
        names.add(name);
      }
    },
    release,
    // Names are derived from the sandbox: what a previous process registered is overwritten, not
    // left behind, so withdrawing this broker's own is all there is to do.
    clear: release,
  };
}

interface HeaderTransformation {
  header: string;
  match: HarnessV1RequestTransformation['match'];
  secret: string;
}

function headersOf(transformations: Transformations): HeaderTransformation[] {
  return transformations.flatMap(({ match, transform }) =>
    Object.entries(transform.headers).map(([header, secret]) => ({ match, header, secret })),
  );
}

/** The value the sandbox sends for `header`, when it is an exact placeholder. */
function sentValue(
  match: HarnessV1RequestTransformation['match'],
  header: string,
): string | undefined {
  const sent = match.headers?.find(({ key }) =>
    key && 'exact' in key ? key.exact.toLowerCase() === header.toLowerCase() : false,
  )?.value;
  return sent && 'exact' in sent ? sent.exact : undefined;
}

/** Headers already warned about, so a long-running process says it once. */
const warned = new Set<string>();

/**
 * The headers a placeholder-swapping proxy can set: those the request carries a placeholder for.
 * The others are left out, with a warning, when their transformation protects a credential.
 */
function swappableHeaders(transformations: Transformations): HeaderTransformation[] {
  return transformations.flatMap((transformation) => {
    const headers = headersOf([transformation]);
    const swappable = headers.filter(({ match, header }) => sentValue(match, header) !== undefined);
    // Nothing to swap: the request carries no credential to protect. Let placeholderOf say so.
    if (swappable.length === 0) return headers;
    for (const { match, header } of headers) {
      const key = `${match.host} ${header}`;
      if (swappable.some((kept) => kept.header === header) || warned.has(key)) continue;
      warned.add(key);
      process.emitWarning(
        `The ${header} header of ${match.host} is left out: a local Docker Sandboxes proxy swaps ` +
          'placeholders, and cannot add a header the request does not carry.',
        { code: 'AI_SDK_SANDBOX_SBX_HEADER_LEFT_OUT' },
      );
    }
    return swappable;
  });
}

/**
 * The placeholder the sandbox sends for `header`, and the value the proxy must put in its place,
 * without the prefix they share.
 */
function placeholderOf(
  match: HarnessV1RequestTransformation['match'],
  header: string,
  secret: string,
): [string, string] {
  const sent = sentValue(match, header);
  if (sent === undefined) {
    throw new HarnessCapabilityUnsupportedError({
      harnessId: SBX_SANDBOX_PROVIDER_ID,
      message: `Cannot broker the ${header} header of ${match.host}: Docker Sandboxes swaps a placeholder, and the request carries none.`,
    });
  }
  let shared = 0;
  while (shared < sent.length && sent[shared] === secret[shared]) shared += 1;
  return [sent.slice(shared), secret.slice(shared)];
}

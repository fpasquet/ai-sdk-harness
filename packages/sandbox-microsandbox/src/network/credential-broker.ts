import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';
import type { SecretModifySpec } from 'microsandbox';

import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';

import type { MicrosandboxConnection } from '../transport/microsandbox-connection.js';

import { MICROSANDBOX_SANDBOX_PROVIDER_ID } from '../provider-id.js';

type Transformations = ReadonlyArray<HarnessV1RequestTransformation>;

/**
 * Keeps credentials out of the sandbox: each request transformation becomes a microsandbox secret,
 * so the real value only exists on this host, and microsandbox's network stack puts it in the
 * requests to the API's host in place of the placeholder the sandbox sends.
 */
export interface CredentialBroker {
  add(transformations: Transformations): Promise<void>;
  /**
   * Makes `transformations` the only secrets of this package the sandbox holds, withdrawing the
   * others, a previous process's included.
   */
  replace(transformations: Transformations): Promise<void>;
  /** Withdraws the secrets this broker registered. */
  release(): Promise<void>;
}

/** Names of the secrets this package registers, so that `replace()` leaves the others alone. */
const SECRET_PREFIX = 'AISDK_';

/**
 * The secret of `header` for `host`. microsandbox also exposes it to the sandbox as a variable of
 * that name, holding the placeholder: hence a name a shell accepts.
 */
export const secretName = (host: string, header: string): string =>
  `${SECRET_PREFIX}${host}_${header}`.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/**
 * Secrets swap a placeholder for a value in the requests to the host. The sandbox sends the
 * harness's placeholder, `Bearer <placeholder>`, and microsandbox puts the secret in its place:
 * only the part that differs is registered.
 *
 * A secret that adds a placeholder restarts the microVM: microsandbox cannot hand a new one to the
 * processes already running. The harness adds its credentials before it starts its bridge, and
 * keeps the same placeholders when a session resumes, which only rotates the values, live.
 */
export function secretBroker(connection: MicrosandboxConnection): CredentialBroker {
  const names = new Set<string>();
  /** Registers `secrets` and withdraws `secretsRemove`, in one change of the sandbox. */
  const apply = async (
    secrets: Record<string, SecretModifySpec>,
    secretsRemove: string[] = [],
  ): Promise<void> => {
    if (Object.keys(secrets).length === 0 && secretsRemove.length === 0) return;
    await connection.modify({ secrets, secretsRemove, policy: 'restart' });
    for (const name of secretsRemove) names.delete(name);
    for (const name of Object.keys(secrets)) names.add(name);
  };

  return {
    add: async (transformations) => {
      await apply(secretsOf(transformations));
    },
    replace: async (transformations) => {
      const secrets = secretsOf(transformations);
      const held = await connection.secretNames();
      await apply(
        secrets,
        held.filter((name) => name.startsWith(SECRET_PREFIX) && !(name in secrets)),
      );
    },
    release: () => apply({}, [...names]),
  };
}

/** The secrets of `transformations`, by name. */
function secretsOf(transformations: Transformations): Record<string, SecretModifySpec> {
  const secrets: Record<string, SecretModifySpec> = {};
  for (const { match, header, secret } of swappableHeaders(transformations)) {
    const [placeholder, value] = placeholderOf(match, header, secret);
    secrets[secretName(match.host, header)] = { value, placeholder, allowedHosts: [match.host] };
  }
  return secrets;
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
 * The headers a placeholder-swapping network stack can set: those the request carries a
 * placeholder for. The others are left out, with a warning, when their transformation protects a
 * credential.
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
        `The ${header} header of ${match.host} is left out: microsandbox swaps placeholders, and ` +
          'cannot add a header the request does not carry.',
        { code: 'AI_SDK_SANDBOX_MICROSANDBOX_HEADER_LEFT_OUT' },
      );
    }
    return swappable;
  });
}

/**
 * The placeholder the sandbox sends for `header`, and the value to put in its place, without the
 * prefix they share.
 */
function placeholderOf(
  match: HarnessV1RequestTransformation['match'],
  header: string,
  secret: string,
): [string, string] {
  const sent = sentValue(match, header);
  if (sent === undefined) {
    throw new HarnessCapabilityUnsupportedError({
      harnessId: MICROSANDBOX_SANDBOX_PROVIDER_ID,
      message: `Cannot broker the ${header} header of ${match.host}: microsandbox swaps a placeholder, and the request carries none.`,
    });
  }
  let shared = 0;
  while (shared < sent.length && sent[shared] === secret[shared]) shared += 1;
  return [sent.slice(shared), secret.slice(shared)];
}

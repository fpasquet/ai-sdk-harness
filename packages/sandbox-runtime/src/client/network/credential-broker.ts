import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';

import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';

import type { InjectedCredential, SrtRuntime } from '../transport/srt-runtime.js';

import { SRT_SANDBOX_PROVIDER_ID } from '../provider-id.js';

type HeaderMatcher = NonNullable<HarnessV1RequestTransformation['match']['headers']>[number];

/** The exact value `matchers` require for the header `name`, if any. */
function exactValue(matchers: readonly HeaderMatcher[], name: string): string | undefined {
  for (const { key, value } of matchers) {
    if (key !== undefined && 'exact' in key && key.exact.toLowerCase() === name.toLowerCase()) {
      if (value !== undefined && 'exact' in value) return value.exact;
    }
  }
  return undefined;
}

/** Headers already warned about, so a long-running process says it once. */
const warned = new Set<string>();

/** Warns, once per host and header, that srt cannot add `header`. */
function leaveOut(host: string, header: string): void {
  const key = `${host} ${header}`;
  if (warned.has(key)) return;
  warned.add(key);
  process.emitWarning(
    `The ${header} header of ${host} is left out: srt's proxy swaps placeholders, and cannot add a header the request does not carry.`,
    { code: 'AI_SDK_SANDBOX_RUNTIME_HEADER_LEFT_OUT' },
  );
}

/**
 * The credentials of one transformation, as srt puts them in requests: for each header it sets,
 * the value the sandbox sends (the rule's exact match on that header) is swapped for the real one,
 * in the requests to the rule's host. A header the sandbox sends no placeholder for cannot be
 * added: when the rule protects a credential otherwise, it is left out with a warning — Codex,
 * logged in with ChatGPT, asks for a `ChatGPT-Account-ID` its backend does without. A rule that
 * would protect nothing is refused.
 */
function credentialsOfRule({
  match,
  transform,
}: HarnessV1RequestTransformation): InjectedCredential[] {
  const headers = Object.entries(transform.headers).map(([name, value]) => ({
    name,
    value,
    placeholder: exactValue(match.headers ?? [], name),
  }));
  const swapped = headers.flatMap(({ value, placeholder }) =>
    placeholder === undefined ? [] : [{ placeholder, value, hosts: [match.host] }],
  );
  const [first] = headers;
  if (swapped.length === 0 && first !== undefined) {
    throw new HarnessCapabilityUnsupportedError({
      harnessId: SRT_SANDBOX_PROVIDER_ID,
      message: `srt swaps a placeholder for a credential: the rule for ${match.host} must match the exact value of the ${first.name} header it sets.`,
    });
  }
  for (const { name, placeholder } of headers) {
    if (placeholder === undefined) leaveOut(match.host, name);
  }
  return swapped;
}

/**
 * The credentials of `transformations`, as srt puts them in requests. srt matches on the host
 * alone: the path, method and query a rule may also name are not checked, and the placeholder is
 * what scopes the swap.
 */
export function credentialsOf(
  transformations: readonly HarnessV1RequestTransformation[],
): InjectedCredential[] {
  return transformations.flatMap(credentialsOfRule);
}

/**
 * The credentials one view of a sandbox registered with srt, which it withdraws on release. The
 * hosts they go to are reported to `onHosts`, for the sandbox to allow them.
 */
export class CredentialBroker {
  private credentials: InjectedCredential[] = [];

  constructor(
    private readonly runtime: SrtRuntime,
    private readonly onHosts: (hosts: readonly string[]) => void,
  ) {}

  add(transformations: readonly HarnessV1RequestTransformation[]): void {
    const added = credentialsOf(transformations);
    for (const credential of added) this.runtime.inject(credential);
    const replaced = new Set(added.map(({ placeholder }) => placeholder));
    this.credentials = [
      ...this.credentials.filter(({ placeholder }) => !replaced.has(placeholder)),
      ...added,
    ];
    this.onHosts(this.hosts());
  }

  replace(transformations: readonly HarnessV1RequestTransformation[]): void {
    const next = credentialsOf(transformations);
    const kept = new Set(next.map(({ placeholder }) => placeholder));
    for (const { placeholder } of this.credentials) {
      if (!kept.has(placeholder)) this.runtime.withdraw(placeholder);
    }
    this.credentials = [];
    this.add(transformations);
  }

  release(): void {
    for (const { placeholder } of this.credentials) this.runtime.withdraw(placeholder);
    this.credentials = [];
    this.onHosts([]);
  }

  private hosts(): string[] {
    return [...new Set(this.credentials.flatMap(({ hosts }) => hosts))];
  }
}

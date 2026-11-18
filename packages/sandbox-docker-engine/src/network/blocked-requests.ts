import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The file of the refused requests in the sandbox's state directory, which the proxy appends to. */
export const BLOCKED_FILE = 'blocked.jsonl';

/** A request out of the sandbox the egress proxy refused. */
export interface DockerBlockedRequest {
  /** The host the sandbox tried to reach: a name, or an IP address. */
  host: string;
  /** The port it tried to reach. */
  port?: number;
  /** When the proxy refused it. */
  at: Date;
  /**
   * Why: `policy` (the network policy does not list the host), `private-address` (the name points
   * to a private address, which the proxy never reaches) or `unresolved` (the name does not
   * resolve).
   */
  reason: 'policy' | 'private-address' | 'unresolved';
}

/** Which of the refused requests to list. */
export interface DockerBlockedRequestsOptions {
  /** Only the requests refused since then: the time of the last change of policy, for instance. */
  since?: Date;
}

const REASONS = new Set(['policy', 'private-address', 'unresolved']);

/** One line of the proxy's log, or `undefined` when it is not one. */
function parseLine(line: string): DockerBlockedRequest | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  const { host, port, at, reason } = (entry ?? {}) as Record<string, unknown>;
  if (typeof host !== 'string' || typeof at !== 'string' || !REASONS.has(reason as string)) {
    return undefined;
  }
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return undefined;
  return {
    host,
    ...(typeof port === 'number' && { port }),
    at: date,
    reason: reason as DockerBlockedRequest['reason'],
  };
}

/**
 * The requests the egress proxy of a sandbox refused, the last refused first, from its log in the
 * state directory: what to tell a person who may then allow them.
 */
export async function blockedRequests(
  directory: string,
  { since }: DockerBlockedRequestsOptions = {},
): Promise<DockerBlockedRequest[]> {
  const log = await readFile(join(directory, BLOCKED_FILE), 'utf8').catch(() => '');
  return log
    .split('\n')
    .flatMap((line) => parseLine(line) ?? [])
    .filter(({ at }) => since === undefined || at >= since)
    .reverse();
}

/**
 * A request out of the sandbox that its network policy refused: what a sandbox package's proxy
 * logs, and what an application keeps to show which host to allow. Plain data: written to a log
 * as JSON, `at` becomes its ISO string.
 */
export interface BlockedRequest {
  /** The host the sandbox tried to reach: a name, or an IP address. */
  host: string;
  /** The port it tried to reach, when known: absent for a name lookup a DNS refused. */
  port?: number;
  /** When the request was refused. */
  at: Date;
  /** The command that sent it, when the sandbox knows it (`git fetch origin`, `npm install`…). */
  command?: string;
}

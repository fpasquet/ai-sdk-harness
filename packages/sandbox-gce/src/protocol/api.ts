/**
 * The bodies of the HTTP API between the client and the sandbox service: both sides read and write
 * them, so they are declared once, here.
 */

/** A sandbox, as the service describes it: where its commands run by default, and its user's home. */
export interface SandboxDescription {
  name: string;
  home: string;
  workingDirectory: string;
}

/** What a sandbox may reach, on top of what the service allows every sandbox. */
export interface SandboxNetwork {
  allowedHosts?: readonly string[];
  baseUrls?: Readonly<Record<string, string>>;
}

/** One command to run in a sandbox. */
export interface SandboxCommand {
  command: string;
  /** Where it runs: the sandbox's working directory by default. */
  workingDirectory?: string;
  /** Variables of its own, beside those of the sandbox. */
  env?: Record<string, string>;
  /**
   * Keep its standard input open once the request ends: it is then written by
   * `POST …/processes/:id/stdin` and ended by `DELETE …/processes/:id/stdin`. Without it, the
   * standard input is what follows the command in the request, and ends with it.
   */
  stdin?: boolean;
}

/**
 * The most bytes one `POST …/processes/:id/stdin` carries, well under the 32 MiB Cloud Run
 * accepts in an HTTP/1 request.
 */
export const MAX_INPUT_WRITE_BYTES = 8 << 20;

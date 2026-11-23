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
}

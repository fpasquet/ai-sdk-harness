/**
 * The bodies of the HTTP API between the client and the sandbox service: both sides read and write
 * them, so they are declared once, here.
 */

/** A sandbox, as the service describes it: where its commands run by default, and its user's home. */
export interface SandboxDescription {
  name: string;
  home: string;
  workingDirectory: string;
  /** How long its creation or resume took, step by step: none from a service of an earlier version. */
  timings?: SandboxTimings;
}

/**
 * How long a creation or a resume took on the service, in milliseconds, step by step. The proxy
 * boots alongside the machine: `proxyMs` overlaps the others, which follow one another.
 */
export interface SandboxTimings {
  /** Whether the creation took a machine of the warm pool, booted ahead of it. Never on a resume. */
  fromPool: boolean;
  /** Waiting for the egress proxy, its machine booting when the service had stopped it: 0 or so when it was up. */
  proxyMs: number;
  /**
   * Compute Engine creating the machine, or taking one of the warm pool, on a creation; starting
   * the stopped machine, or waiting for one on its way, on a resume: 0 or so when it ran.
   */
  insertMs: number;
  /** The machine running and its guest booting, until its agent answers. */
  bootMs: number;
  /** Registering the sandbox with the proxy and configuring its agent. */
  agentMs: number;
  /** The whole call, on the service, checks included. */
  totalMs: number;
}

/**
 * A sandbox's machine, as Compute Engine describes it: when it ran, how it is billed, what it is
 * made of. `GET /v1/sandboxes/:name` answers it, running or stopped.
 */
export interface SandboxInfo {
  /** The sandbox's name. */
  name: string;
  /**
   * The Compute Engine instance holding it: `<prefix><name>`, or `<prefix>pool-<hex>` for a machine
   * taken from the warm pool, which Compute Engine cannot rename.
   */
  instance: string;
  /** The zone of the machine. */
  zone: string;
  /** `RUNNING`, `STOPPING`, `TERMINATED` (stopped, its disk kept)… as Compute Engine says. */
  status: string;
  /**
   * When the machine was made, an RFC 3339 timestamp: for a machine of the warm pool, before the
   * sandbox took it.
   */
  creationTimestamp?: string;
  /** When the machine last started: none before it first did. */
  lastStartTimestamp?: string;
  /** When the machine last stopped: none before it first did. */
  lastStopTimestamp?: string;
  /**
   * How it is billed: `SPOT`, or `STANDARD`. A service of Spot machines makes a standard one when
   * the zone has no Spot capacity left, which `spotFallback` says.
   */
  provisioningModel: 'SPOT' | 'STANDARD';
  /** Whether the service makes Spot machines but this one is standard, for want of Spot capacity. */
  spotFallback: boolean;
  /** The machine type: `e2-standard-4`, `e2-custom-4-8192`… */
  machineType: string;
  /** The size of its boot disk, in GB. */
  diskSizeGb?: number;
  /** The service's name of the image it was made on: `default` and the like. */
  image?: string;
  /** Whether the machine was taken from the warm pool. */
  fromPool: boolean;
  /** The caller's labels, as the machine holds them: those of the package left out. */
  labels: Record<string, string>;
}

/** What a sandbox may reach, on top of what the service allows every sandbox. */
export interface SandboxNetwork {
  allowedHosts?: readonly string[];
  baseUrls?: Readonly<Record<string, string>>;
  /** Sets `NODE_USE_ENV_PROXY=1` for the sandbox's commands: the service's setting without it. */
  nodeUseEnvProxy?: boolean;
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

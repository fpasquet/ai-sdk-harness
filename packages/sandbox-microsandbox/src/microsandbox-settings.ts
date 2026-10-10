import type {
  HarnessV1NetworkPolicy,
  HarnessV1SandboxSessionCreateOptions,
  HarnessV1SandboxSessionResumeOptions,
} from '@ai-sdk/harness';

/** How this process talks to a sandbox, the same whether the sandbox was just created or resumed. */
export interface MicrosandboxConnectionSettings {
  /**
   * Keep credentials out of the sandbox: each request transformation the harness asks for becomes
   * a microsandbox secret, whose real value the sandbox's network stack puts in the requests on
   * their way out to the API's host. Turn it off only to debug: the harness then forwards the real
   * credential into the sandbox environment.
   *
   * @defaultValue `true`
   */
  brokerCredentials?: boolean;
}

/** What a new sandbox is made of. Fixed at creation: microsandbox cannot change it afterwards. */
export interface MicrosandboxCreationSettings extends MicrosandboxConnectionSettings {
  /**
   * The OCI image the microVM boots from, pulled from its registry the first time. The harness
   * needs Node.js in it; `node:24` also ships git, curl and Python.
   *
   * @defaultValue `'node:24'`
   */
  image?: string;
  /**
   * The user every command runs as, but `setup`. It must exist in the image, with a home
   * directory. Run the harness as an unprivileged user: Claude Code refuses to skip its permission
   * prompts as `root`.
   *
   * @defaultValue `'node'` with the default image, its unprivileged user; the image's own user
   * with any other `image`
   */
  user?: string;
  /**
   * Ports inside the sandbox the harness may reach, each published on this host's loopback, on a
   * free port picked at creation. Bridge-backed harnesses (Claude Code, Codex…) listen on the
   * first. microsandbox publishes ports when it creates the sandbox only: list them all here.
   *
   * @defaultValue `[]`
   */
  ports?: readonly number[];
  /**
   * vCPUs of the microVM.
   *
   * @defaultValue `2`
   */
  cpus?: number;
  /**
   * Memory of the microVM, in MiB. Installing a harness takes more than microsandbox's own 512.
   *
   * @defaultValue `2048`
   */
  memory?: number;
  /**
   * A directory of this host bind-mounted read-write at `/workspace`, the sandbox's working
   * directory: the agent edits your files. Without it the sandbox mounts nothing of the host.
   */
  workspace?: string;
  /**
   * What the sandbox may reach. Without it, microsandbox's own default applies: the public
   * internet, but no private, loopback or link-local address of the host's networks. `custom`
   * allows the listed hosts only, a `*.example.com` entry standing for the domain and its
   * subdomains; `deniedCIDRs` win over everything.
   */
  networkPolicy?: HarnessV1NetworkPolicy;
  /**
   * Commands run once, as `root`, right after the sandbox is created, to install a tool the
   * harness needs, say. With a `template`, they run before it is prepared and are baked into it.
   */
  setup?: readonly string[];
}

/** Options of `createMicrosandboxNetworkSandboxSession()`. */
export type MicrosandboxNetworkSandboxSessionCreateOptions =
  HarnessV1SandboxSessionCreateOptions<MicrosandboxCreationSettings>;

/** Options of `resumeMicrosandboxNetworkSandboxSession()`. */
export type MicrosandboxNetworkSandboxSessionResumeOptions =
  HarnessV1SandboxSessionResumeOptions<MicrosandboxConnectionSettings>;

import type {
  HarnessV1SandboxSessionCreateOptions,
  HarnessV1SandboxSessionResumeOptions,
} from '@ai-sdk/harness';

/**
 * Whether calls to the sandbox service carry a Google identity token besides the service token:
 * for a service behind Identity-Aware Proxy, or a load balancer that checks one.
 *
 * - `'none'`: no identity token, the service token alone.
 * - `'gcloud'`: the gcloud CLI's account (`gcloud auth print-identity-token`), on a developer's
 *   machine.
 * - `'metadata'`: the service account of the workload, from the metadata server, on Google Cloud
 *   (Cloud Run, GKE, Compute Engine).
 * - a function returning a token: any other source, such as `google-auth-library`'s
 *   `getIdTokenClient(url)`. It is called again when the last token is about to expire.
 */
export type GkeAuth = 'gcloud' | 'metadata' | 'none' | (() => Promise<string> | string);

/** How this process talks to a sandbox, the same whether the sandbox was just created or resumed. */
export interface GkeConnectionSettings {
  /**
   * The URL of the sandbox service: the Kubernetes Service running `ai-sdk-sandbox-gke serve`,
   * which drives the pods of the sandboxes, as this process reaches it: through an internal load
   * balancer, say, `http://10.10.0.5`.
   */
  url: string;
  /**
   * The secret the service was deployed with in `SANDBOX_SERVICE_TOKEN`: whoever holds it drives
   * every sandbox. Keep it in a secret manager.
   */
  serviceToken: string;
  /**
   * Whether calls carry a Google identity token besides the service token.
   *
   * @defaultValue `'none'`
   */
  auth?: GkeAuth;
  /**
   * Ports inside the sandbox the harness may reach, through a WebSocket tunnel of the service.
   * Bridge-backed harnesses (Claude Code, Codex…) listen on the first.
   *
   * @defaultValue `[]`
   */
  ports?: readonly number[];
  /**
   * Hosts the sandbox may reach over HTTPS, on top of those the service allows every sandbox.
   * `*.domain` covers a domain's subdomains. The sandbox's pod has no way out of its own: the
   * network policy only lets it reach the egress proxy, which refuses any other host. A harness bootstrap needs its
   * package registry: `registry.npmjs.org` for Claude Code and Codex.
   *
   * @defaultValue `[]`
   */
  allowedHosts?: readonly string[];
  /**
   * Environment variables holding the base URL of an API whose credentials are kept out of the
   * sandbox, and the URL each leads to. Each is pointed at the egress proxy, and so is a value a
   * command sets for it: the requests then leave through the proxy, which puts the real credential
   * in. Merged over the service's own, which by default cover Claude Code and Codex:
   * `ANTHROPIC_BASE_URL` (`https://api.anthropic.com`) and `OPENAI_BASE_URL`
   * (`https://api.openai.com/v1`).
   *
   * @defaultValue `{}`
   */
  baseUrls?: Readonly<Record<string, string>>;
}

/** What a new sandbox is made of. */
export interface GkeCreationSettings extends GkeConnectionSettings {
  /**
   * The container image the sandbox's pod runs, by the name the service gives it in
   * `SANDBOX_IMAGES`: one per toolchain, say `python` or `go`. The service refuses a name it does
   * not offer: callers never pick an arbitrary image.
   *
   * @defaultValue the service's `SANDBOX_IMAGE`
   */
  image?: string;
  /**
   * Commands the sandbox must have once `setup` ran, which may install them: a harness needs Node.js for
   * its bridge and git for the repositories, whatever the project's language. A missing one fails
   * the creation with `GkeSandboxImageError`, the sandbox deleted. `[]` checks nothing.
   *
   * @defaultValue `['node', 'git']`
   */
  requiredCommands?: readonly string[];
  /**
   * Commands run once, right after the sandbox is created, as the sandbox's user, never root:
   * what they install goes in its home (`~/.local`, `~/.cargo`…), the one directory kept across
   * suspensions and in templates. With a `template`, they run before it is prepared and are saved
   * in it.
   *
   * @defaultValue `[]`
   */
  setup?: readonly string[];
}

/** Options of `createGkeNetworkSandboxSession()`. */
export type GkeNetworkSandboxSessionCreateOptions =
  HarnessV1SandboxSessionCreateOptions<GkeCreationSettings>;

/** Options of `resumeGkeNetworkSandboxSession()`. */
export type GkeNetworkSandboxSessionResumeOptions =
  HarnessV1SandboxSessionResumeOptions<GkeConnectionSettings>;

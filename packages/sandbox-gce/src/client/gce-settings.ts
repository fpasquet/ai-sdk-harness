import type {
  HarnessV1SandboxSessionCreateOptions,
  HarnessV1SandboxSessionResumeOptions,
} from '@ai-sdk/harness';

/**
 * How calls to the sandbox service are authenticated. The service runs on Cloud Run, deployed with
 * `--no-allow-unauthenticated`: each call carries a Google identity token, granted
 * `roles/run.invoker` on the service.
 *
 * - `'gcloud'`: the gcloud CLI's account (`gcloud auth print-identity-token`), on a developer's
 *   machine.
 * - `'metadata'`: the service account of the workload, from the metadata server, on Google Cloud
 *   (Cloud Run, GKE, Compute Engine).
 * - `'none'`: no token, for a service run locally.
 * - a function returning a token: any other source, such as `google-auth-library`'s
 *   `getIdTokenClient(url)`. It is called again when the last token is about to expire.
 */
export type GceAuth = 'gcloud' | 'metadata' | 'none' | (() => Promise<string> | string);

/** How this process talks to a sandbox, the same whether the sandbox was just created or resumed. */
export interface GceConnectionSettings {
  /**
   * The URL of the sandbox service: a Cloud Run service running `ai-sdk-sandbox-gce serve`, which
   * drives the Compute Engine machines of the sandboxes: what `gcloud run services describe` prints
   * as its URL.
   */
  url: string;
  /**
   * How calls to the service are authenticated.
   *
   * @defaultValue `'gcloud'`
   */
  auth?: GceAuth;
  /**
   * The secret the service was deployed with in `SANDBOX_SERVICE_TOKEN`, if any: a second lock
   * beside Cloud Run's IAM, should the service ever be left open. Keep it in a secret manager.
   */
  serviceToken?: string;
  /**
   * Ports inside the sandbox the harness may reach, through a WebSocket tunnel of the service.
   * Bridge-backed harnesses (Claude Code, Codex…) listen on the first.
   *
   * @defaultValue `[]`
   */
  ports?: readonly number[];
  /**
   * Hosts the sandbox may reach over HTTPS, on top of those the service allows every sandbox.
   * `*.domain` covers a domain's subdomains. The sandbox's machine has no way out of its own: the
   * VPC firewall only lets it reach the egress proxy, which refuses any other host. A harness bootstrap needs its
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
export interface GceCreationSettings extends GceConnectionSettings {
  /**
   * The image the sandbox's machine boots from, by the name the service gives it in
   * `SANDBOX_IMAGES`: one per toolchain, say `python` or `go`. The service refuses a name it does
   * not offer: callers never pick an arbitrary image.
   *
   * @defaultValue the service's `SANDBOX_IMAGE`
   */
  image?: string;
  /**
   * Commands the sandbox must have once `setup` ran, which may install them: a harness needs Node.js for
   * its bridge and git for the repositories, whatever the project's language. A missing one fails
   * the creation with `GceSandboxImageError`, the sandbox deleted. `[]` checks nothing.
   *
   * @defaultValue `['node', 'git']`
   */
  requiredCommands?: readonly string[];
  /**
   * Commands run once, right after the sandbox is created, as the sandbox's user, who has `sudo`
   * without a password. With a `template`, they run before it is prepared and are saved in it.
   *
   * @defaultValue `[]`
   */
  setup?: readonly string[];
}

/** Options of `createGceNetworkSandboxSession()`. */
export type GceNetworkSandboxSessionCreateOptions =
  HarnessV1SandboxSessionCreateOptions<GceCreationSettings>;

/** Options of `resumeGceNetworkSandboxSession()`. */
export type GceNetworkSandboxSessionResumeOptions =
  HarnessV1SandboxSessionResumeOptions<GceConnectionSettings>;

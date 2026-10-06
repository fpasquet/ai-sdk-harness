import type {
  HarnessV1SandboxSessionCreateOptions,
  HarnessV1SandboxSessionResumeOptions,
} from '@ai-sdk/harness';

/**
 * How calls to the sandbox service are authenticated. The service is deployed with
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
export type CloudRunAuth = 'gcloud' | 'metadata' | 'none' | (() => Promise<string> | string);

/** How this process talks to a sandbox, the same whether the sandbox was just created or resumed. */
export interface CloudRunConnectionSettings {
  /**
   * The URL of the sandbox service: a Cloud Run service running `ai-sdk-sandbox-cloud-run serve`,
   * deployed with `--sandbox-launcher`: what `gcloud run services describe` prints as its URL.
   */
  url: string;
  /**
   * How calls to the service are authenticated.
   *
   * @defaultValue `'gcloud'`
   */
  auth?: CloudRunAuth;
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
   * `*.domain` covers a domain's subdomains. The sandbox has no network of its own: everything goes
   * through the service's egress proxy, which refuses any other host. A harness bootstrap needs its
   * package registry: `registry.npmjs.org` for Claude Code and Codex.
   *
   * @defaultValue `[]`
   */
  allowedHosts?: readonly string[];
  /**
   * Environment variables holding the base URL of an API whose credentials are kept out of the
   * sandbox, and the URL each leads to. Each is pointed at the sandbox's egress relay, and so is a
   * value a command sets for it: the requests then leave through the service, which puts the real
   * credential in. Merged over the service's own, which by default cover Claude Code and Codex:
   * `ANTHROPIC_BASE_URL` (`https://api.anthropic.com`) and `OPENAI_BASE_URL`
   * (`https://api.openai.com/v1`).
   *
   * @defaultValue `{}`
   */
  baseUrls?: Readonly<Record<string, string>>;
}

/** What a new sandbox is made of. */
export interface CloudRunCreationSettings extends CloudRunConnectionSettings {
  /**
   * Commands run once, right after the sandbox is created, as root. With a `template`, they run
   * before it is prepared and are saved in it.
   *
   * @defaultValue `[]`
   */
  setup?: readonly string[];
}

/** Options of `createCloudRunNetworkSandboxSession()`. */
export type CloudRunNetworkSandboxSessionCreateOptions =
  HarnessV1SandboxSessionCreateOptions<CloudRunCreationSettings>;

/** Options of `resumeCloudRunNetworkSandboxSession()`. */
export type CloudRunNetworkSandboxSessionResumeOptions =
  HarnessV1SandboxSessionResumeOptions<CloudRunConnectionSettings>;

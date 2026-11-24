import type {
  HarnessV1SandboxSessionCreateOptions,
  HarnessV1SandboxSessionResumeOptions,
  HarnessV1SandboxTemplate,
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
  /**
   * Sets `NODE_USE_ENV_PROXY=1` for the sandbox's commands: Node.js's own `fetch` and `http` then
   * leave through the egress relay, as package managers, git and the harnesses already do. Off by
   * default: it breaks the test suites that mock `fetch` by its sockets, such as MSW 3, whose
   * requests then reach the relay instead of their mocks. Turn it on for code that calls an outside
   * API with Node.js's `fetch` and no proxy support of its own. A command can still set it itself.
   *
   * @defaultValue the service's `SANDBOX_NODE_USE_ENV_PROXY`, `false` by default
   */
  nodeUseEnvProxy?: boolean;
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

/** Options of `deleteCloudRunSandbox()`: the sandbox, and the service it was created through. */
export interface CloudRunSandboxDeletionSettings extends CloudRunConnectionSettings {
  /** The id the sandbox was created with. */
  sandboxId: string;
  /** Aborts the call. */
  abortSignal?: AbortSignal;
}

/** Options of `deleteCloudRunSandboxTemplate()`: the template, as the sandboxes made from it were. */
export interface CloudRunTemplateDeletionSettings extends CloudRunConnectionSettings {
  /** The template the sandboxes were created from, `await agent.getSandboxTemplate()`. */
  template: HarnessV1SandboxTemplate;
  /**
   * The `setup` the sandboxes were created with: with the template, what names the template.
   *
   * @defaultValue `[]`
   */
  setup?: readonly string[];
  /** Aborts the call. */
  abortSignal?: AbortSignal;
}

/** Options of `createCloudRunNetworkSandboxSession()`. */
export type CloudRunNetworkSandboxSessionCreateOptions =
  HarnessV1SandboxSessionCreateOptions<CloudRunCreationSettings>;

/** Options of `resumeCloudRunNetworkSandboxSession()`. */
export type CloudRunNetworkSandboxSessionResumeOptions =
  HarnessV1SandboxSessionResumeOptions<CloudRunConnectionSettings>;

import type {
  HarnessV1SandboxSessionCreateOptions,
  HarnessV1SandboxSessionResumeOptions,
  HarnessV1SandboxTemplate,
} from '@ai-sdk/harness';

import type { GceSandboxReport } from './gce-usage.js';

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
  /**
   * Sets `NODE_USE_ENV_PROXY=1` for the sandbox's commands: Node.js's own `fetch` and `http` then
   * leave through the egress proxy, as package managers, git and the harnesses already do. Off by
   * default: it breaks the test suites that mock `fetch` by its sockets, such as MSW 3, whose
   * requests then reach the proxy instead of their mocks. Turn it on for code that calls an outside
   * API with Node.js's `fetch` and no proxy support of its own. A command can still set it itself.
   *
   * @defaultValue the service's `SANDBOX_NODE_USE_ENV_PROXY`, `false` by default
   */
  nodeUseEnvProxy?: boolean;
  /**
   * Called with the last measures of the sandbox each time this session, or a view of it, stops or
   * destroys it, and by `deleteGceSandbox()`: what its connections carried through the egress
   * proxy, and what the agent of its machine sampled, which the proxy and the disk lose then. What
   * an application that leaves the stops to `ai-sdk-harness-sessions` keeps them with. Awaited; an
   * error it throws is ignored, the stop done all the same.
   */
  onUsageReport?: (report: GceSandboxReport) => Promise<void> | void;
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
   * Labels put on the sandbox's machine and on its disk, beside the service's own: what a Cloud
   * Billing export, or a budget, groups their cost by. Keys start with a lowercase letter, then
   * lowercase letters, digits, `_` or `-`, values the same but may be empty, 63 characters at most
   * each, 56 labels at most. Keys starting with `ai-sdk-` are the package's: refused. A machine
   * taken from the warm pool gets them as it is taken, its disk too. A template's builder gets those
   * of the creation that builds it.
   *
   * @defaultValue `{}`
   */
  labels?: Readonly<Record<string, string>>;
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

/** Options of `prepareGceSandboxService()`: the sandbox likely to be created next. */
export interface GcePrepareSettings extends GceConnectionSettings {
  /**
   * The template the sandbox will be created from, `await agent.getSandboxTemplate()`: the service
   * boots a machine from it ahead of the sandbox, which the creation takes. Only once the template
   * exists on the service: preparing never builds it. Without it, only the egress proxy is booted.
   */
  template?: HarnessV1SandboxTemplate;
  /**
   * The `setup` the sandbox will be created with: with the template, what names the template's
   * image.
   *
   * @defaultValue `[]`
   */
  setup?: readonly string[];
  /**
   * The image the sandbox will be created on, by the name the service gives it in `SANDBOX_IMAGES`.
   *
   * @defaultValue the service's `SANDBOX_IMAGE`
   */
  image?: string;
  /** Aborts the call. */
  abortSignal?: AbortSignal;
}

/** Options of `deleteGceSandboxTemplate()`: the template, as the sandboxes made from it were. */
export interface GceTemplateDeletionSettings extends GceConnectionSettings {
  /** The template the sandboxes were created from, `await agent.getSandboxTemplate()`. */
  template: HarnessV1SandboxTemplate;
  /**
   * The `setup` the sandboxes were created with: with the template, what names the template's
   * image.
   *
   * @defaultValue `[]`
   */
  setup?: readonly string[];
  /**
   * The image the sandboxes were created on, by the name the service gives it in `SANDBOX_IMAGES`.
   *
   * @defaultValue the service's `SANDBOX_IMAGE`
   */
  image?: string;
  /** Aborts the call. */
  abortSignal?: AbortSignal;
}

/**
 * Options of `describeGceSandbox()` and of the other calls about one sandbox: the sandbox, and the
 * service it was created through.
 */
export interface GceSandboxLookupSettings extends GceConnectionSettings {
  /** The id the sandbox was created with. */
  sandboxId: string;
  /** Aborts the call. */
  abortSignal?: AbortSignal;
}

/** Options of `deleteGceSandbox()`: the sandbox, and the service it was created through. */
export type GceSandboxDeletionSettings = GceSandboxLookupSettings;

/** Options of `createGceNetworkSandboxSession()`. */
export type GceNetworkSandboxSessionCreateOptions =
  HarnessV1SandboxSessionCreateOptions<GceCreationSettings>;

/** Options of `resumeGceNetworkSandboxSession()`. */
export type GceNetworkSandboxSessionResumeOptions =
  HarnessV1SandboxSessionResumeOptions<GceConnectionSettings>;

import type {
  HarnessV1SandboxSessionCreateOptions,
  HarnessV1SandboxSessionResumeOptions,
} from '@ai-sdk/harness';

import type { SrtRuntimeSettings } from './transport/srt-runtime.js';

/**
 * The hosts a new sandbox may reach unless told otherwise: the npm registry, where a harness
 * installs its runtime, and the APIs of the models the harnesses call. The hosts a brokered
 * credential goes to are allowed on top.
 */
export const DEFAULT_ALLOWED_DOMAINS: readonly string[] = [
  'registry.npmjs.org',
  'api.anthropic.com',
  'api.openai.com',
  'chatgpt.com',
  'ai-gateway.vercel.sh',
];

/** How this process works with a sandbox, the same whether it was just created or resumed. */
export interface SrtConnectionSettings {
  /**
   * Ports inside the sandbox the harness may reach. Each is forwarded the first time it is asked
   * for, to a free port of this host's loopback. Bridge-backed harnesses (Claude Code, Codex…)
   * listen on the first.
   *
   * @defaultValue `[]`
   */
  ports?: readonly number[];
  /**
   * Keep credentials out of the sandbox: it holds a placeholder, and srt's proxy puts the real
   * value in the requests to the credential's host, past TLS termination. Turn it off to have the
   * harness forward the real credential into the sandbox's environment instead.
   *
   * @defaultValue `true`
   */
  brokerCredentials?: boolean;
  /**
   * Where the sandboxes live, one directory each: its home, its working directory and its
   * settings.
   *
   * @defaultValue `~/.ai-sdk-sandbox-runtime`
   */
  directory?: string;
  /**
   * Settings of srt itself, shared by every sandbox of this process: the first sandbox created or
   * resumed applies them.
   */
  runtime?: SrtRuntimeSettings;
}

/** What a new sandbox may read, write and reach. Fixed at creation, kept for its resumption. */
export interface SrtCreationSettings extends SrtConnectionSettings {
  /**
   * A directory of this host the sandbox works in, read-write: the agent edits your files.
   * Without it, the sandbox works in a directory of its own.
   */
  workspace?: string;
  /** More directories of this host the sandbox may read, never write: documentation, a library… */
  readOnlyWorkspaces?: readonly string[];
  /**
   * The hosts the sandbox may reach, in srt's syntax: `example.com`, `*.example.com`, with an
   * optional `:port`. Nothing else goes through, but the hosts brokered credentials go to.
   *
   * @defaultValue {@link DEFAULT_ALLOWED_DOMAINS}
   */
  allowedDomains?: readonly string[];
  /**
   * Hide this host user's home directory from the sandbox, but for what it needs: its own
   * directory, the workspaces, Node.js and the directories of the `PATH`. Your credentials — SSH
   * keys, cloud logins, the `claude` and `gh` ones — stay out of reach.
   *
   * @defaultValue `true`
   */
  hideHome?: boolean;
  /** Paths the sandbox may not read, on top of the home directory. */
  denyRead?: readonly string[];
  /** Paths the sandbox may read inside a hidden region, such as a tool installed in your home. */
  allowRead?: readonly string[];
  /** More paths the sandbox may write, besides its own directory and the workspace. */
  allowWrite?: readonly string[];
  /** Paths the sandbox may never write, even inside a writable one. */
  denyWrite?: readonly string[];
  /**
   * Commands run once, right after the sandbox is created, before its template: to install a tool
   * the harness needs, say. They run in the sandbox, under its rules.
   */
  setup?: readonly string[];
}

/** Options of `createSrtNetworkSandboxSession()`. */
export type SrtNetworkSandboxSessionCreateOptions =
  HarnessV1SandboxSessionCreateOptions<SrtCreationSettings>;

/** Options of `resumeSrtNetworkSandboxSession()`. */
export type SrtNetworkSandboxSessionResumeOptions =
  HarnessV1SandboxSessionResumeOptions<SrtConnectionSettings>;

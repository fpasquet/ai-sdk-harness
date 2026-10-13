import type { HarnessAgentSandboxConfig } from '@ai-sdk/harness/agent';

import type { Workspace } from '../definitions/workspace.js';

/** The settings of a `HarnessAgent` the workspace takes part in. */
export interface WorkspaceAgentSettings {
  readonly harness: { readonly harnessId: string };
  readonly sandboxConfig?: HarnessAgentSandboxConfig;
  /** @deprecated Use `sandboxConfig.onSession` instead. */
  readonly onSandboxSession?: HarnessAgentSandboxConfig['onSession'];
}

/** What {@link withWorkspace} returns: the settings it was given, with its `sandboxConfig.onSession`. */
export type WithWorkspace<SETTINGS extends WorkspaceAgentSettings> = Omit<
  SETTINGS,
  'onSandboxSession' | 'sandboxConfig'
> & { readonly sandboxConfig: HarnessAgentSandboxConfig };

/**
 * `settings` with a `sandboxConfig.onSession` that checks `workspace` out in each session's working
 * directory — or finds the checkout again when the session resumes — before your own `onSession`
 * runs, and before the agent starts. With `ai-sdk-harness-plugins`, apply the plugins last,
 * `withPlugins(withWorkspace(settings, workspace), plugins)`: their files are then written in the
 * checkout, and kept out of its changes.
 */
export function withWorkspace<SETTINGS extends WorkspaceAgentSettings>(
  settings: SETTINGS,
  workspace: Workspace,
): WithWorkspace<SETTINGS> {
  const onSession = settings.sandboxConfig?.onSession ?? settings.onSandboxSession;
  const { onSandboxSession: _deprecated, ...rest } = settings;
  // The settings as given, but for what is set below: a generic `Omit` TypeScript cannot follow.
  return {
    ...rest,
    sandboxConfig: {
      ...settings.sandboxConfig,
      onSession: async (input) => {
        await workspace.onSession(input);
        await onSession?.(input);
      },
    },
  } as WithWorkspace<SETTINGS>;
}

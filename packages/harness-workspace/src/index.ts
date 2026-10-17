export type { SourceFetchContext, WorkspaceSource } from './definitions/source.js';
export type {
  ChangedFile,
  MultiRepositoryWorkspaceOptions,
  SessionSandboxes,
  SessionSandboxLease,
  SingleRepositoryWorkspaceOptions,
  SingleRepositoryWorkspaceSession,
  Workspace,
  WorkspaceCheckout,
  WorkspaceCommandResult,
  WorkspaceOptions,
  WorkspaceRepositoryOptions,
  WorkspaceRunOptions,
  WorkspaceSession,
  WorkspaceSessionInput,
} from './definitions/workspace.js';
export { WorkspaceError } from './errors/workspace-error.js';
export { WorkspaceLostError } from './errors/workspace-lost-error.js';
export { WorkspaceSetupError } from './errors/workspace-setup-error.js';
export { gitRepository } from './sources/git-repository.js';
export type { GitCredentials, GitRepositoryOptions } from './sources/git-repository.js';
export { hostRepository } from './sources/host-repository.js';
export type { HostRepositoryOptions } from './sources/host-repository.js';
export { sandboxRepository } from './sources/sandbox-repository.js';
export type { SandboxRepositoryOptions } from './sources/sandbox-repository.js';
export { createWorkspace } from './workspace/create-workspace.js';
export { withWorkspace } from './workspace/with-workspace.js';
export type { WithWorkspace, WorkspaceAgentSettings } from './workspace/with-workspace.js';

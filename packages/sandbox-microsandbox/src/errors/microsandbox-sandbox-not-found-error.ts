/** No sandbox of that name exists on this host: it was never created, or it was removed. */
export class MicrosandboxSandboxNotFoundError extends Error {
  readonly sandboxId: string;

  constructor(sandboxId: string) {
    super(
      `No microsandbox named "${sandboxId}" exists on this host. ` +
        'Create it with createMicrosandboxNetworkSandboxSession({ sandboxId }) first.',
    );
    this.name = 'MicrosandboxSandboxNotFoundError';
    this.sandboxId = sandboxId;
  }
}

/** No sandbox of that name exists on this host: it was never created, or `sbx rm` removed it. */
export class SbxSandboxNotFoundError extends Error {
  readonly sandboxId: string;

  constructor(sandboxId: string) {
    super(
      `No Docker Sandbox named "${sandboxId}" exists on this host. ` +
        'Create it with createSbxNetworkSandboxSession({ sandboxId }) first.',
    );
    this.name = 'SbxSandboxNotFoundError';
    this.sandboxId = sandboxId;
  }
}

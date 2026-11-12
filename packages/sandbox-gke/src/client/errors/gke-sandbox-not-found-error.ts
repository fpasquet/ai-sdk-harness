/** No sandbox of that name exists, running or stopped: it was never created, or it was deleted. */
export class GkeSandboxNotFoundError extends Error {
  readonly sandboxId: string;

  constructor(sandboxId: string) {
    super(
      `No GKE sandbox named "${sandboxId}" exists on this service. ` +
        'Create it with createGkeNetworkSandboxSession({ sandboxId }) first.',
    );
    this.name = 'GkeSandboxNotFoundError';
    this.sandboxId = sandboxId;
  }
}

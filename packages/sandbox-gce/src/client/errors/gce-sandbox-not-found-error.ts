/** No sandbox of that name exists, running or stopped: it was never created, or it was deleted. */
export class GceSandboxNotFoundError extends Error {
  readonly sandboxId: string;

  constructor(sandboxId: string) {
    super(
      `No Compute Engine sandbox named "${sandboxId}" exists on this service. ` +
        'Create it with createGceNetworkSandboxSession({ sandboxId }) first.',
    );
    this.name = 'GceSandboxNotFoundError';
    this.sandboxId = sandboxId;
  }
}

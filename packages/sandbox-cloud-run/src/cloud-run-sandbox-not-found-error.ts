/** No sandbox of that name runs or waits as a snapshot: it was never created, or it was deleted. */
export class CloudRunSandboxNotFoundError extends Error {
  readonly sandboxId: string;

  constructor(sandboxId: string) {
    super(
      `No Cloud Run sandbox named "${sandboxId}" exists on this service. ` +
        'Create it with createCloudRunNetworkSandboxSession({ sandboxId }) first.',
    );
    this.name = 'CloudRunSandboxNotFoundError';
    this.sandboxId = sandboxId;
  }
}

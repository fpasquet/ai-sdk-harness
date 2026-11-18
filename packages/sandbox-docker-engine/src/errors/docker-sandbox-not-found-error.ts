/** No sandbox of this name is on this host's Docker Engine: removed, or never created. */
export class DockerSandboxNotFoundError extends Error {
  readonly sandboxId: string;

  constructor(sandboxId: string) {
    super(`No Docker sandbox named "${sandboxId}" on this host: create it again.`);
    this.name = 'DockerSandboxNotFoundError';
    this.sandboxId = sandboxId;
  }
}

import { SrtError } from './srt-error.js';

/** No sandbox of that id in the directory: `resumeSrtNetworkSandboxSession()` never creates one. */
export class SrtSandboxNotFoundError extends SrtError {
  override readonly name: string = 'SrtSandboxNotFoundError';

  constructor(readonly sandboxId: string) {
    super(`There is no sandbox "${sandboxId}" to resume.`);
  }
}

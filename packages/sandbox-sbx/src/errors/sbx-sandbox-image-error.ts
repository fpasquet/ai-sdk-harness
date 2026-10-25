/**
 * The image of a new sandbox lacks a command the harness needs: Node.js for its bridge, git for the
 * repositories. Whatever the project's language, the image carries them beside its own toolchain.
 */
export class SbxSandboxImageError extends Error {
  readonly sandboxId: string;
  /** The commands the image lacks. */
  readonly missing: readonly string[];

  constructor(sandboxId: string, missing: readonly string[]) {
    super(
      `The image of Docker Sandbox "${sandboxId}" lacks ${missing.join(', ')}: a harness needs them in the sandbox, whatever the project's language. Add them to the image, install them with \`setup\`, or pick another \`image\`.`,
    );
    this.name = 'SbxSandboxImageError';
    this.sandboxId = sandboxId;
    this.missing = missing;
  }
}

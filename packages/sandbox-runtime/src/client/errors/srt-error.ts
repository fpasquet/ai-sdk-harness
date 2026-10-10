/** A sandbox could not be created, reached or used: srt refused, or the supervisor failed. */
export class SrtError extends Error {
  override readonly name: string = 'SrtError';
}

/** What an error tells its caller beyond its message: a code to tell it by, and headers. */
export interface HttpErrorDetails {
  /** What the caller tells the error by, rather than by its message: `SANDBOX_MAX_RUNNING`. */
  code?: string;
  /** Fields put in the answer's body beside `error` and `code`. */
  fields?: Readonly<Record<string, unknown>>;
  /** Headers of the answer: `retry-after`, say. */
  headers?: Readonly<Record<string, string>>;
}

/** An error a server of the package answers with its own status, rather than a 500. */
export class HttpError extends Error {
  readonly details: HttpErrorDetails;

  constructor(
    readonly status: number,
    message: string,
    details: HttpErrorDetails = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.details = details;
  }
}

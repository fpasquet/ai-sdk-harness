/** The sandbox service answered a call with an error status. */
export class CloudRunSandboxServiceError extends Error {
  /** The method and path of the call. */
  readonly request: string;
  readonly status: number;

  constructor(request: string, status: number, message: string) {
    super(`${request} failed with ${status}: ${message}`);
    this.name = 'CloudRunSandboxServiceError';
    this.request = request;
    this.status = status;
  }
}

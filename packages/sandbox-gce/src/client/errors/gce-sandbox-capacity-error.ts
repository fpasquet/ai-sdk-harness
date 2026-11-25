import { GceSandboxServiceError } from './gce-sandbox-service-error.js';

/**
 * The service runs as many sandboxes as its `SANDBOX_MAX_RUNNING` allows, and refused to create or
 * resume one more: answered with a 429, its `status`. Wait `retryAfterSeconds`, or stop a sandbox,
 * and try again: queue the call rather than fail it. The count is made at each call, so two calls
 * at once may both pass, and run one sandbox more than the most.
 */
export class GceSandboxCapacityError extends GceSandboxServiceError {
  /** The sandboxes running, or booting, when the call was refused. */
  readonly running: number;
  /** The most the service runs at once. */
  readonly max: number;
  /** How long the service says to wait before trying again, in seconds. */
  readonly retryAfterSeconds: number;

  constructor(
    request: string,
    message: string,
    {
      running,
      max,
      retryAfterSeconds,
    }: { running: number; max: number; retryAfterSeconds: number },
  ) {
    super(request, 429, message);
    this.name = 'GceSandboxCapacityError';
    this.running = running;
    this.max = max;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

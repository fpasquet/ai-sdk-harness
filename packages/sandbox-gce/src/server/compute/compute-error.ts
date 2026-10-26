import { HttpError } from '../../common/http-error.js';

/** The error a Compute Engine call answered with: its status kept, so that 404 and 409 mean as much. */
export class ComputeError extends HttpError {
  /**
   * @param code The error code of a failed operation, `ZONE_RESOURCE_POOL_EXHAUSTED` say, when it
   *   gave one.
   */
  constructor(
    status: number,
    message: string,
    readonly code?: string,
  ) {
    super(status, `Compute Engine: ${message}`);
    this.name = 'ComputeError';
  }

  /** Whether the zone had no machine of the kind asked for: Spot capacity, most often. */
  get outOfCapacity(): boolean {
    return /RESOURCE_POOL_EXHAUSTED|STOCKOUT/.test(this.code ?? '');
  }
}

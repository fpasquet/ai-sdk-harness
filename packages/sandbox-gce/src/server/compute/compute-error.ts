import { HttpError } from '../../common/http-error.js';

/** The error a Compute Engine call answered with: its status kept, so that 404 and 409 mean as much. */
export class ComputeError extends HttpError {
  constructor(status: number, message: string) {
    super(status, `Compute Engine: ${message}`);
    this.name = 'ComputeError';
  }
}

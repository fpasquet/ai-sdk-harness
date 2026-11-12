import { HttpError } from '../../common/http-error.js';

/** The error a Kubernetes call answered with: its status kept, so that 404 and 409 mean as much. */
export class KubernetesError extends HttpError {
  constructor(status: number, message: string) {
    super(status, `Kubernetes: ${message}`);
    this.name = 'KubernetesError';
  }
}

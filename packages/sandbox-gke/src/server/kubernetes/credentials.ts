import { readFileSync } from 'node:fs';

/** Where Kubernetes mounts the service account of a pod. */
export const SERVICE_ACCOUNT_DIRECTORY = '/var/run/secrets/kubernetes.io/serviceaccount';

/** How long the token read from its file is kept: Kubernetes rotates it well before it expires. */
const TOKEN_KEPT_MS = 60_000;

/**
 * Where the service gets what authenticates its calls to the Kubernetes API: `'service-account'`,
 * the token and the cluster's certificate authority Kubernetes mounts in the service's pod;
 * `'none'`, nothing, for an API reached through `kubectl proxy` or the tests' fake.
 */
export type KubernetesAuth = 'none' | 'service-account';

/** The token of the calls, and the authority the API's certificate is checked against. */
export class KubernetesCredentials {
  /** The cluster's certificate authority, in PEM: the system's authorities without it. */
  readonly ca?: string;
  private token?: { value: string; until: number };

  constructor(
    private readonly auth: KubernetesAuth,
    private readonly directory = SERVICE_ACCOUNT_DIRECTORY,
  ) {
    if (auth === 'service-account') this.ca = readFileSync(`${directory}/ca.crt`, 'utf8');
  }

  /** The service account's namespace, where the service works unless told otherwise. */
  namespace(): string | undefined {
    if (this.auth === 'none') return undefined;
    return readFileSync(`${this.directory}/namespace`, 'utf8').trim();
  }

  /** A valid token, read again from its file now and then; `undefined` with `'none'`. */
  bearer(): string | undefined {
    if (this.auth === 'none') return undefined;
    if (this.token === undefined || Date.now() >= this.token.until) {
      const value = readFileSync(`${this.directory}/token`, 'utf8').trim();
      this.token = { value, until: Date.now() + TOKEN_KEPT_MS };
    }
    return this.token.value;
  }
}

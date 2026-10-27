import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** A token is fetched again this long before it expires. */
const MARGIN_MS = 5 * 60_000;

/** How long a gcloud token is kept: Google's last an hour. */
const GCLOUD_LIFETIME_MS = 45 * 60_000;

/**
 * Where the service gets the OAuth access tokens of its calls to the Compute Engine API:
 * `'metadata'`, the service account of the Cloud Run service; `'gcloud'`, the gcloud CLI's account,
 * for a service run on a developer's machine; `'none'`, no token, for the tests' fake API.
 */
export type ComputeAuth = 'gcloud' | 'metadata' | 'none';

interface Token {
  value: string;
  expiresAt: number;
}

async function metadataToken(): Promise<Token> {
  const response = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'metadata-flavor': 'Google' } },
  );
  if (!response.ok) {
    throw new Error(`The metadata server refused an access token: ${response.status}`);
  }
  const { access_token: value, expires_in: lifetime } = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };
  return { value, expiresAt: Date.now() + lifetime * 1000 - MARGIN_MS };
}

async function gcloudToken(): Promise<Token> {
  const { stdout } = await run('gcloud', ['auth', 'print-access-token'], { timeout: 30_000 });
  return { value: stdout.trim(), expiresAt: Date.now() + GCLOUD_LIFETIME_MS - MARGIN_MS };
}

/** Access tokens from `auth`, fetched once and again before they expire. */
export class AccessToken {
  private token?: Token;
  private fetching?: Promise<Token>;

  constructor(private readonly auth: ComputeAuth) {}

  /** A valid token, or `undefined` with `'none'`. */
  async get(): Promise<string | undefined> {
    if (this.auth === 'none') return undefined;
    if (this.token !== undefined && Date.now() < this.token.expiresAt) return this.token.value;
    this.fetching ??= (this.auth === 'metadata' ? metadataToken() : gcloudToken()).finally(
      () => (this.fetching = undefined),
    );
    this.token = await this.fetching;
    return this.token.value;
  }
}

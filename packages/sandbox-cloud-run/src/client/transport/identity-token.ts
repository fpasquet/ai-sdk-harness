import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { CloudRunAuth } from '../cloud-run-settings.js';

const run = promisify(execFile);

/** A token is fetched again this long before it expires. */
const MARGIN_MS = 5 * 60_000;
/** How long a token whose expiry cannot be read is kept: Google's last an hour. */
const UNKNOWN_LIFETIME_MS = 45 * 60_000;

/** When a JWT expires, from its `exp` claim, if it can be read. */
function expiryOf(token: string): number | undefined {
  try {
    const payload = token.split('.')[1] ?? '';
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp?: unknown };
    return typeof exp === 'number' ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Identity tokens, fetched once and again before they expire: what Cloud Run's IAM checks on every
 * call to a service deployed with `--no-allow-unauthenticated`.
 */
export class IdentityToken {
  private fetching?: Promise<string>;
  private token?: { expiresAt: number; value: string };

  constructor(private readonly fetchToken: () => Promise<string> | string) {}

  /** A valid token, fetched again when the last one is about to expire. */
  async get(): Promise<string> {
    if (this.token !== undefined && Date.now() < this.token.expiresAt) return this.token.value;
    this.fetching ??= this.refresh().finally(() => (this.fetching = undefined));
    return this.fetching;
  }

  /**
   * The last token, at once: for a WebSocket that reconnects on its own and reads its headers
   * synchronously. A token about to expire is fetched again meanwhile, for the next attempt.
   */
  current(): string {
    if (this.token === undefined || Date.now() >= this.token.expiresAt) {
      void this.get().catch(() => undefined);
    }
    return this.token?.value ?? '';
  }

  private async refresh(): Promise<string> {
    const value = (await this.fetchToken()).trim();
    const expiry = expiryOf(value) ?? Date.now() + UNKNOWN_LIFETIME_MS + MARGIN_MS;
    this.token = { value, expiresAt: expiry - MARGIN_MS };
    return value;
  }
}

async function gcloudToken(): Promise<string> {
  try {
    // On Windows, gcloud is a batch file, which only a shell runs; its arguments here are fixed.
    const { stdout } = await (process.platform === 'win32'
      ? run('gcloud.cmd', ['auth', 'print-identity-token'], { timeout: 30_000, shell: true })
      : run('gcloud', ['auth', 'print-identity-token'], { timeout: 30_000 }));
    return stdout;
  } catch (error) {
    throw new Error(
      `Could not get an identity token from gcloud: run \`gcloud auth login\`, or set the \`auth\` option. ${String(error)}`,
      { cause: error },
    );
  }
}

async function metadataToken(audience: string): Promise<string> {
  const url = new URL(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity',
  );
  url.searchParams.set('audience', audience);
  const response = await fetch(url, { headers: { 'metadata-flavor': 'Google' } });
  if (!response.ok) {
    throw new Error(`The metadata server refused an identity token: ${response.status}`);
  }
  return response.text();
}

/** Tokens already fetched, by source: every session on the same service shares them. */
const shared = new Map<string, IdentityToken>();

/** The identity tokens `auth` calls for, on the service at `url`: none for `'none'`. */
export function identityToken(auth: CloudRunAuth, url: string): IdentityToken | undefined {
  if (auth === 'none') return undefined;
  if (typeof auth === 'function') return new IdentityToken(auth);
  const audience = new URL(url).origin;
  const key = `${auth} ${audience}`;
  let token = shared.get(key);
  if (token === undefined) {
    token = new IdentityToken(auth === 'gcloud' ? gcloudToken : () => metadataToken(audience));
    shared.set(key, token);
  }
  return token;
}

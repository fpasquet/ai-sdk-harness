import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1RequestTransformation,
} from '@ai-sdk/harness';

import { randomUUID } from 'node:crypto';

import type { SourceFetchContext, WorkspaceSource } from '../definitions/source.js';

import { WorkspaceError } from '../errors/workspace-error.js';
import { fetchInto } from '../git/repository.js';
import { checkRevision, repositoryName } from '../utils/names.js';

/** A credential for a private repository, as Git over HTTPS takes it: a user and a token. */
export interface GitCredentials {
  /**
   * The user the token goes with: GitHub takes `x-access-token` with an app's installation token,
   * GitLab `oauth2`, Bitbucket `x-token-auth`.
   *
   * @defaultValue `'x-access-token'`
   */
  username?: string;
  /** The token, or the password. Prefer a short-lived, read-only one. */
  token: string;
}

export interface GitRepositoryOptions {
  /**
   * The repository's URL, such as `https://github.com/acme/widgets.git`. `http:` and `file:` URLs
   * are taken too, without credentials.
   */
  url: string;
  /**
   * What a new checkout starts from: a branch, a tag, or a commit the server lets clients fetch.
   *
   * @defaultValue `'HEAD'`, the repository's default branch
   */
  ref?: string;
  /** Fetch this many commits of history only. Default: the whole history. */
  depth?: number;
  /**
   * The credential of a private repository, or a function that gives it, called at each fetch: a
   * token that expires — a GitHub App's installation token — is asked for when it is needed. It
   * never enters the sandbox: the sandbox's credential brokering (`addRequestTransformations`)
   * puts it in the requests to the repository's host on their way out, the sandbox only holding
   * a placeholder, so a sandbox without it is refused. `https:` URLs only.
   */
  credentials?: (() => PromiseLike<GitCredentials | undefined>) | GitCredentials;
  /**
   * The name of the repository in the sandbox.
   *
   * @defaultValue the last segment of `url`, without `.git`
   */
  name?: string;
}

/**
 * A repository a Git server serves, over HTTPS: fetched in the sandbox at each new session, the
 * commits it already has not fetched again. Its `hosts`, the host of `url`, are what the network
 * policy of a closed sandbox must allow.
 *
 * Its credential stays on your server, but a process of the sandbox that learns the placeholder
 * while a fetch runs can reach the repository's host with it for as long as the session's sandbox
 * holds it: give a token that can read the repository, and nothing else.
 */
export function gitRepository(options: GitRepositoryOptions): WorkspaceSource {
  const url = parseUrl(options.url);
  const revision = checkRevision(options.ref ?? 'HEAD', '`ref`');
  if (options.depth !== undefined && !(Number.isInteger(options.depth) && options.depth > 0)) {
    throw new TypeError(`\`depth\` must be a positive integer; got ${options.depth}.`);
  }
  if (options.credentials !== undefined && url.protocol !== 'https:') {
    throw new TypeError(
      `Credentials only go to an https: URL; got ${url.protocol} for ${url.host}.`,
    );
  }
  return {
    name: options.name ?? repositoryName(url.pathname),
    hosts: hostsOf(url),
    fetch: async (context) => {
      const credentials =
        typeof options.credentials === 'function'
          ? await options.credentials()
          : options.credentials;
      const env = {
        ...(credentials !== undefined && (await brokeredHeader(context, url, credentials))),
      };
      await fetchInto(context.sandbox, {
        repository: context.repository,
        from: options.url,
        revision,
        ref: context.ref,
        depth: options.depth,
        env,
        abortSignal: context.abortSignal,
      });
    },
  };
}

function parseUrl(location: string): URL {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new TypeError(
      `\`url\` must be the URL of a Git repository; got ${JSON.stringify(location)}.`,
    );
  }
  if (!['file:', 'http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new TypeError(
      `\`url\` must be an https:, http: or file: URL without credentials in it; got ${url.protocol}//${url.host}${url.pathname}.`,
    );
  }
  return url;
}

/**
 * The host the sandbox fetches `url` from, as a network policy names it: its hostname alone, an
 * IPv6 address without its brackets; none for a `file:` URL. A network policy allows a host on
 * every port: a port of the URL is left out.
 */
function hostsOf(url: URL): readonly string[] {
  if (url.protocol === 'file:' || url.hostname === '') return [];
  return [url.hostname.replace(/^\[(.*)\]$/, '$1')];
}

/**
 * Registers `credentials` with the sandbox's credential brokering, for the requests to the
 * repository, and returns the environment that makes git send the placeholder in their place.
 * The placeholder is new at each fetch: views of one sandbox each register their own.
 */
async function brokeredHeader(
  { sandbox }: SourceFetchContext,
  url: URL,
  { username = 'x-access-token', token }: GitCredentials,
): Promise<Record<string, string>> {
  const broker = brokering(sandbox);
  if (broker === undefined) {
    throw new WorkspaceError(
      `The sandbox cannot keep the credential of ${url.host} out of it: it has no credential brokering (addRequestTransformations). Turn it on in its sandbox package, or fetch the repository on this host with hostRepository().`,
      'fetch',
    );
  }
  const basic = (password: string) =>
    `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const placeholder = basic(`ai-sdk-harness-${randomUUID()}`);
  const path = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
  const transformation: HarnessV1RequestTransformation = {
    match: {
      host: url.host,
      ...(path !== '' && { path: { startsWith: path } }),
      headers: [{ key: { exact: 'Authorization' }, value: { exact: placeholder } }],
    },
    transform: { headers: { Authorization: basic(token) } },
  };
  await broker([transformation]);
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: ${placeholder}`,
  };
}

function brokering(
  sandbox: HarnessV1NetworkSandboxSession,
): HarnessV1NetworkSandboxSession['addRequestTransformations'] {
  return sandbox.addRequestTransformations?.bind(sandbox);
}

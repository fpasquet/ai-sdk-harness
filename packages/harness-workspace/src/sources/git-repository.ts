import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1RequestTransformation,
} from '@ai-sdk/harness';

import { randomUUID } from 'node:crypto';

import type {
  SourceConnectContext,
  SourceConnection,
  WorkspaceSource,
} from '../definitions/source.js';

import { WorkspaceError } from '../errors/workspace-error.js';
import { connectRemote, fetchInto } from '../git/repository.js';
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
  /**
   * Gives each session's checkout an `origin` remote, the repository's URL, its branches fetched
   * with the checkout into `refs/remotes/origin/*`: the agent can `git fetch`, `git ls-remote`,
   * `git rebase origin/main` or `git checkout -b fix origin/fix` for as long as the session lives.
   *
   * It only reads. With `credentials`, the checkout's git configuration holds a placeholder of
   * the session's own, never the token, and the sandbox's credential brokering swaps it for the
   * token only in the requests that read the repository — `GET <path>/info/refs` with
   * `service=git-upload-pack` and `POST <path>/git-upload-pack` — and refuses it on any other: a
   * `git push` never carries the token. That takes a sandbox whose brokering matches the method,
   * path and query of a request, and refuses a placeholder no rule covers (its
   * `credentialBrokering.scope` is `'request'`: `ai-sdk-sandbox-gce`, `ai-sdk-sandbox-cloud-run`):
   * any other sandbox is refused. Without `credentials`, the remote sends none, on any sandbox.
   *
   * @defaultValue `false`: the checkout has no remote
   */
  readOnlyRemote?: boolean | ReadOnlyRemoteOptions;
}

/** How the read-only remote of {@link GitRepositoryOptions.readOnlyRemote} keeps its credential. */
export interface ReadOnlyRemoteOptions {
  /**
   * How often, while a session lives, `credentials` — a function — is asked again, the token it
   * gives replacing the one before: return one that lasts at least this long. It is asked again at
   * each resume too, and by `session.refreshCredentials()` of the workspace whenever you call it.
   *
   * @defaultValue `900_000`, 15 minutes
   */
  refreshIntervalMs?: number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60_000;

/**
 * A repository a Git server serves, over HTTPS: fetched in the sandbox at each new session, the
 * commits it already has not fetched again. Its `hosts`, the host of `url`, are what the network
 * policy of a closed sandbox must allow.
 *
 * Its credential stays on your server. The sandbox's brokering swaps the placeholder for it in
 * the requests that read the repository, at its exact path: where the brokering matches the host
 * alone, a process of the sandbox that learns the placeholder while a fetch runs can reach the
 * repository's host with it for as long as the session's sandbox holds it. Give a token that can
 * read the repository, and nothing else, either way.
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
  const remote = remoteOptions(options.readOnlyRemote);
  const credentials = async (): Promise<GitCredentials | undefined> =>
    typeof options.credentials === 'function' ? options.credentials() : options.credentials;
  return {
    name: options.name ?? repositoryName(url.pathname),
    hosts: hostsOf(url),
    fetch: async ({ sandbox, repository, ref, abortSignal }) => {
      const credential = await credentials();
      if (credential !== undefined && remote !== undefined) checkReadOnly(sandbox, url);
      const env = credential === undefined ? {} : await brokeredHeader(sandbox, url, credential);
      await fetchInto(sandbox, {
        repository,
        from: options.url,
        revision,
        ref,
        depth: options.depth,
        env,
        remoteBranches: remote !== undefined,
        abortSignal,
      });
    },
    ...(remote !== undefined && {
      connect: (context: SourceConnectContext) =>
        connectReadOnly(context, {
          url,
          location: options.url,
          credentials,
          refresh: typeof options.credentials === 'function' ? remote.refreshIntervalMs : undefined,
        }),
    }),
  };
}

function remoteOptions(
  remote: GitRepositoryOptions['readOnlyRemote'],
): Required<ReadOnlyRemoteOptions> | undefined {
  if (remote === undefined || remote === false) return undefined;
  const { refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS } = remote === true ? {} : remote;
  if (!(Number.isInteger(refreshIntervalMs) && refreshIntervalMs > 0)) {
    throw new TypeError(
      `\`readOnlyRemote.refreshIntervalMs\` must be a positive integer; got ${refreshIntervalMs}.`,
    );
  }
  return { refreshIntervalMs };
}

/**
 * Gives the checkout its read-only remote: with a credential, a placeholder of the session's own in
 * its configuration, registered with the sandbox's brokering for the requests that read the
 * repository, and registered again with a new token every `refresh` milliseconds.
 */
async function connectReadOnly(
  { sandbox, directory, abortSignal }: SourceConnectContext,
  {
    url,
    location,
    credentials,
    refresh,
  }: {
    url: URL;
    location: string;
    credentials: () => Promise<GitCredentials | undefined>;
    refresh: number | undefined;
  },
): Promise<SourceConnection | undefined> {
  const signal = abortSignal === undefined ? {} : { abortSignal };
  const first = await credentials();
  if (first === undefined) {
    await connectRemote(sandbox, { directory, url: location, ...signal });
    return undefined;
  }
  checkReadOnly(sandbox, url);
  const placeholder = newPlaceholder(first);
  const broker = brokering(sandbox, url, 'remote');
  // Registered before git holds it: no request leaves with a placeholder the proxy does not know.
  await broker(readRules(url, placeholder, first));
  await connectRemote(sandbox, {
    directory,
    url: location,
    header: `Authorization: ${placeholder}`,
    ...signal,
  });
  const renew = async (): Promise<void> => {
    const credential = await credentials();
    // The same rules, for the same placeholder: the sandbox replaces them, the token with them.
    if (credential !== undefined) await broker(readRules(url, placeholder, credential));
  };
  if (refresh === undefined) return { refresh: renew };
  const timer = setInterval(() => {
    // A failed renewal is tried again at the next one: the rules keep the token before it.
    renew().catch(() => undefined);
  }, refresh);
  timer.unref();
  return { refresh: renew, close: () => clearInterval(timer) };
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
 * Registers `credentials` with the sandbox's credential brokering, for the requests that read the
 * repository, and returns the environment that makes git send the placeholder in their place. The
 * placeholder is new at each fetch: views of one sandbox each register their own.
 */
async function brokeredHeader(
  sandbox: HarnessV1NetworkSandboxSession,
  url: URL,
  credentials: GitCredentials,
): Promise<Record<string, string>> {
  const broker = brokering(sandbox, url, 'fetch');
  const placeholder = newPlaceholder(credentials);
  await broker(readRules(url, placeholder, credentials));
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: ${placeholder}`,
  };
}

const basic = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

/** A placeholder of the credential, as git sends it in `Authorization`: new at each call. */
const newPlaceholder = ({ username = 'x-access-token' }: GitCredentials): string =>
  basic(username, `ai-sdk-harness-${randomUUID()}`);

/**
 * The rules that swap `placeholder` for the credential, in the requests of Git's smart HTTP
 * protocol that read the repository, and those only: the ref advertisement of `git-upload-pack`
 * and the fetch itself, at the repository's path with and without `.git`, on its host. Each path
 * is exact: `/acme/api` does not cover `/acme/api-other`. `git-receive-pack`, a push, is none of
 * them, and a sandbox whose brokering matches whole requests refuses the placeholder there.
 */
export function readRules(
  url: URL,
  placeholder: string,
  { username = 'x-access-token', token }: GitCredentials,
): HarnessV1RequestTransformation[] {
  const base = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
  const paths = base === '' ? [''] : [base, `${base}.git`];
  const headers = [{ key: { exact: 'Authorization' }, value: { exact: placeholder } }];
  const transform = { headers: { Authorization: basic(username, token) } };
  return paths.flatMap((path) => [
    {
      match: {
        host: url.hostname,
        path: { exact: `${path}/info/refs` },
        method: ['GET'],
        queryString: [{ key: { exact: 'service' }, value: { exact: 'git-upload-pack' } }],
        headers,
      },
      transform,
    },
    {
      match: {
        host: url.hostname,
        path: { exact: `${path}/git-upload-pack` },
        method: ['POST'],
        headers,
      },
      transform,
    },
  ]);
}

/**
 * Throws unless the sandbox's credential brokering applies the whole of each rule and refuses a
 * placeholder no rule covers: elsewhere, a placeholder that lasts the session would let any
 * process of the sandbox push with the token.
 */
function checkReadOnly(sandbox: HarnessV1NetworkSandboxSession, url: URL): void {
  const scope = (sandbox as { credentialBrokering?: { scope?: unknown } }).credentialBrokering
    ?.scope;
  if (scope === 'request') return;
  throw new WorkspaceError(
    `A read-only remote of ${url.host} needs a sandbox whose credential brokering matches the method, path and query of each request, and refuses a placeholder no rule covers (\`credentialBrokering.scope\` 'request', as ai-sdk-sandbox-gce and ai-sdk-sandbox-cloud-run declare); this one ${scope === undefined ? 'declares no scope' : `declares ${JSON.stringify(scope)}`}, so a process of the sandbox could push with the token. Leave \`readOnlyRemote\` out on it: the checkout is still fetched, without a remote.`,
    'remote',
  );
}

function brokering(
  sandbox: HarnessV1NetworkSandboxSession,
  url: URL,
  step: string,
): NonNullable<HarnessV1NetworkSandboxSession['addRequestTransformations']> {
  const broker = sandbox.addRequestTransformations?.bind(sandbox);
  if (broker === undefined) {
    throw new WorkspaceError(
      `The sandbox cannot keep the credential of ${url.host} out of it: it has no credential brokering (addRequestTransformations). Turn it on in its sandbox package, or fetch the repository on this host with hostRepository().`,
      step,
    );
  }
  return broker;
}

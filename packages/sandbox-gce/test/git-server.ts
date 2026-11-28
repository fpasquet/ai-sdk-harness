import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { execFile, spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Git as the tests run it: none of this host's configuration. */
export const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** A request the Git server received: what it was asked, with what credential. */
export interface GitServerRequest {
  method: string;
  /** Path and query string. */
  path: string;
  authorization: string | undefined;
}

/** A Git server of the tests, on the loopback. */
export interface GitServer {
  port: number;
  /** What it was asked, in order. */
  requests: GitServerRequest[];
  /** The commit at the head of `main`. */
  head: string;
  /** The `Authorization` it takes: change it to renew the credential. */
  accepted: string;
  close(): Promise<void>;
}

/** Two bare repositories in `root`, `acme/api.git` and `acme/api-other.git`: the commit of `main`. */
async function createRepositories(root: string): Promise<string> {
  const work = join(root, 'work');
  const env = { ...process.env, ...GIT_ENV };
  const git = (cwd: string, ...args: string[]) =>
    run('git', ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args], {
      cwd,
      env,
    });
  await run('git', ['init', '--quiet', '--initial-branch=main', work], { env });
  await writeFile(join(work, 'README.md'), '# API\n');
  await git(work, 'add', '.');
  await git(work, 'commit', '--quiet', '-m', 'First');
  for (const name of ['api', 'api-other']) {
    await git(root, 'clone', '--quiet', '--bare', work, `acme/${name}.git`);
  }
  return (await git(work, 'rev-parse', 'HEAD')).stdout.trim();
}

/** Answers `request` with `git http-backend`, as a web server runs it: a CGI program. */
function serveBackend(root: string, request: IncomingMessage, response: ServerResponse): void {
  const url = new URL(request.url ?? '/', 'http://git.test');
  const backend = spawn('git', ['http-backend'], {
    env: {
      ...process.env,
      ...GIT_ENV,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      REMOTE_USER: 'tester',
      REMOTE_ADDR: '127.0.0.1',
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method ?? 'GET',
      CONTENT_TYPE: request.headers['content-type'] ?? '',
      HTTP_CONTENT_ENCODING: request.headers['content-encoding'] ?? '',
      GIT_PROTOCOL: String(request.headers['git-protocol'] ?? ''),
    },
  });
  request.pipe(backend.stdin);
  let head = Buffer.alloc(0);
  let answered = false;
  backend.stdout.on('data', (chunk: Buffer) => {
    if (answered) {
      response.write(chunk);
      return;
    }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end === -1) return;
    answered = true;
    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of head.subarray(0, end).toString().split('\r\n')) {
      const colon = line.indexOf(':');
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
      else headers[name] = value;
    }
    response.writeHead(status, headers);
    response.write(head.subarray(end + 4));
  });
  backend.on('close', () => response.end());
}

/**
 * A Git smart HTTP server on the loopback, `git http-backend` behind it, serving two bare
 * repositories, `acme/api.git` and `acme/api-other.git`, each a commit on `main`: reads and pushes
 * alike, to whoever sends `Authorization: <authorization>`, and to nobody else.
 */
export async function startGitServer(authorization: string): Promise<GitServer> {
  const root = await mkdtemp(join(tmpdir(), 'git-server-'));
  const head = await createRepositories(root);
  const requests: GitServerRequest[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://git.test');
    requests.push({
      method: request.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.authorization,
    });
    if (request.headers.authorization !== served.accepted) {
      response.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }).end();
      return;
    }
    serveBackend(root, request, response);
  });
  const served: GitServer = {
    port: 0,
    requests,
    head,
    accepted: authorization,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  served.port = (server.address() as AddressInfo).port;
  return served;
}

/** The rules `gitRepository()` of `ai-sdk-harness-workspace` registers to read `path` of `host`. */
export function readRules(
  host: string,
  path: string,
  placeholder: string,
  authorization: string,
): HarnessV1RequestTransformation[] {
  const headers = [{ key: { exact: 'Authorization' }, value: { exact: placeholder } }];
  const transform = { headers: { Authorization: authorization } };
  return [path, `${path}.git`].flatMap((at) => [
    {
      match: {
        host,
        path: { exact: `${at}/info/refs` },
        method: ['GET'],
        queryString: [{ key: { exact: 'service' }, value: { exact: 'git-upload-pack' } }],
        headers,
      },
      transform,
    },
    {
      match: { host, path: { exact: `${at}/git-upload-pack` }, method: ['POST'], headers },
      transform,
    },
  ]);
}

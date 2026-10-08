import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ServiceOptions } from './http/sandbox-server.js';
import type { Logger } from './logger.js';
import type { SandboxSettings } from './sandboxes/sandbox.js';
import type { SnapshotStore } from './snapshots/snapshot-store.js';

import { DEFAULT_BASE_URLS } from './egress/relay-routes.js';
import { PACKAGE_VERSION } from './package-version.js';
import { SandboxCli } from './runtime/sandbox-cli.js';
import { DirectorySnapshotStore } from './snapshots/directory-snapshot-store.js';
import { GcsSnapshotStore } from './snapshots/gcs-snapshot-store.js';

type Environment = Readonly<Record<string, string | undefined>>;

/** Where the service listens, and how it reports. */
export interface ListenConfig {
  port: number;
  host: string;
  jsonLogs: boolean;
}

/** `value`, unless it is unset or empty. */
const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value;

/** `a,b,c` as a list, blanks dropped. */
const list = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/** `NAME=url,NAME=url` as a record. */
function baseUrls(raw: string | undefined): Record<string, string> {
  if (raw === undefined) return { ...DEFAULT_BASE_URLS };
  return Object.fromEntries(
    list(raw).map((entry) => {
      const at = entry.indexOf('=');
      if (at < 1) throw new Error(`SANDBOX_BASE_URLS: \`${entry}\` is not NAME=url.`);
      return [entry.slice(0, at), entry.slice(at + 1)];
    }),
  );
}

/** Cloud Run sets `K_SERVICE` in the instances of a service. */
const onCloudRun = (env: Environment): boolean => env['K_SERVICE'] !== undefined;

/** Where the service listens: every interface on Cloud Run, the loopback anywhere else. */
export function listenConfig(env: Environment): ListenConfig {
  return {
    port: Number.parseInt(env['PORT'] ?? '8080', 10),
    host: env['HOST'] ?? (onCloudRun(env) ? '0.0.0.0' : '127.0.0.1'),
    jsonLogs: (env['LOG_FORMAT'] ?? (onCloudRun(env) ? 'json' : 'text')) === 'json',
  };
}

/**
 * The service's settings, from the environment: every variable has a default fit for Cloud Run.
 * `{sandbox}` in a sandbox's paths is its name.
 */
export function sandboxesConfig(env: Environment, logger: Logger): ServiceOptions {
  return {
    cli: new SandboxCli(
      env['SANDBOX_CLI'] ?? '/usr/local/gcp/bin/sandbox',
      env['SANDBOX_ALLOW_EGRESS'] === 'true',
    ),
    store: snapshotStore(env),
    logger,
    sandbox: sandboxSettings(env),
    network: {
      allowedHosts: list(env['SANDBOX_ALLOWED_HOSTS']),
      baseUrls: baseUrls(env['SANDBOX_BASE_URLS']),
    },
    scratch: tmpdir(),
    layerTransfer: env['SNAPSHOT_TRANSFER'] === 'file' ? 'file' : 'fifo',
    templateNamespace: templateNamespace(env),
    serviceToken: nonEmpty(env['SANDBOX_SERVICE_TOKEN']),
  };
}

/**
 * What the templates are made on: this package, its Node.js, and the image, which
 * `SANDBOX_IMAGE_ID` names (an image digest, a commit) or, failing that, the Cloud Run revision,
 * which changes on every deployment. A template is only ever used on the image it was made on.
 */
export function templateNamespace(env: Environment): string {
  const image = env['SANDBOX_IMAGE_ID'] ?? env['K_REVISION'] ?? 'local';
  return createHash('sha256')
    .update(JSON.stringify([PACKAGE_VERSION, process.version, image]))
    .digest('hex')
    .slice(0, 16);
}

/** A bucket on Cloud Run, where the instance's disk goes away with it; a directory elsewhere. */
function snapshotStore(env: Environment): SnapshotStore {
  const bucket = env['SNAPSHOT_BUCKET'];
  if (bucket !== undefined) return new GcsSnapshotStore(bucket);
  if (onCloudRun(env)) {
    throw new Error(
      'SNAPSHOT_BUCKET is required on Cloud Run: the instance disk goes away with the instance.',
    );
  }
  return new DirectorySnapshotStore(resolve(env['SNAPSHOT_DIRECTORY'] ?? '.snapshots'));
}

/** Private networks, for a service run locally: on Cloud Run they lead to the metadata server. */
function allowPrivateNetwork(env: Environment): boolean {
  if (env['SANDBOX_ALLOW_PRIVATE_NETWORK'] !== 'true') return false;
  if (onCloudRun(env)) {
    throw new Error(
      'SANDBOX_ALLOW_PRIVATE_NETWORK is refused on Cloud Run: it would open the metadata server, and the service account token, to the sandboxes.',
    );
  }
  return true;
}

function sandboxSettings(env: Environment): SandboxSettings {
  return {
    node: env['SANDBOX_NODE'] ?? process.execPath,
    helpers: fileURLToPath(new URL('../in-sandbox/', import.meta.url)),
    path: env['SANDBOX_PATH'] ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    home: env['SANDBOX_HOME'] ?? '/home/agent',
    workingDirectory: env['SANDBOX_WORKDIR'] ?? '/workspace',
    egressPort: Number.parseInt(env['SANDBOX_EGRESS_PORT'] ?? '3128', 10),
    allowPrivateNetwork: allowPrivateNetwork(env),
  };
}

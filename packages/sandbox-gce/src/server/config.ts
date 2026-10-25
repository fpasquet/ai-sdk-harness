import type { Logger } from '../common/logger.js';
import type { ServiceOptions } from './http/sandbox-server.js';
import type { MachineSettings } from './sandboxes/sandboxes.js';

import { DEFAULT_AGENT_PORT } from '../protocol/agent.js';
import { DEFAULT_BASE_URLS } from '../protocol/proxy-routes.js';
import { AccessToken, type ComputeAuth } from './compute/access-token.js';
import { ComputeApi } from './compute/compute-api.js';
import { ProxyAdmin } from './sandboxes/proxy-admin.js';

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

function required(env: Environment, name: string, why: string): string {
  const value = nonEmpty(env[name]);
  if (value === undefined) throw new Error(`${name} is required: ${why}.`);
  return value;
}

/** Where the service listens: every interface on Cloud Run, the loopback anywhere else. */
export function listenConfig(env: Environment): ListenConfig {
  return {
    port: Number.parseInt(env['PORT'] ?? '8080', 10),
    host: env['HOST'] ?? (onCloudRun(env) ? '0.0.0.0' : '127.0.0.1'),
    jsonLogs: (env['LOG_FORMAT'] ?? (onCloudRun(env) ? 'json' : 'text')) === 'json',
  };
}

/** The project the service runs in, from the metadata server: on Google Cloud only. */
async function metadataProject(): Promise<string> {
  const response = await fetch(
    'http://metadata.google.internal/computeMetadata/v1/project/project-id',
    { headers: { 'metadata-flavor': 'Google' } },
  ).catch(() => undefined);
  if (response?.ok !== true) {
    throw new Error('SANDBOX_PROJECT is required off Google Cloud: the project of the sandboxes.');
  }
  return (await response.text()).trim();
}

/** An image given by name only is one of the project's. */
function imagePath(image: string, project: string): string {
  return image.startsWith('projects/') ? image : `projects/${project}/global/images/${image}`;
}

/** What the sandboxes' machines are made of. */
function machineSettings(env: Environment, project: string): MachineSettings {
  return {
    machineType: env['SANDBOX_MACHINE_TYPE'] ?? 'e2-standard-4',
    image: imagePath(
      required(env, 'SANDBOX_IMAGE', 'the image of the sandboxes, a name or a family'),
      project,
    ),
    diskSizeGb: Number.parseInt(env['SANDBOX_DISK_GB'] ?? '20', 10),
    diskType: env['SANDBOX_DISK_TYPE'] ?? 'pd-balanced',
    network: nonEmpty(env['SANDBOX_NETWORK']),
    subnetwork: nonEmpty(env['SANDBOX_SUBNETWORK']),
    tags: list(env['SANDBOX_NETWORK_TAGS'] ?? 'ai-sdk-sandbox'),
    spot: env['SANDBOX_SPOT'] === 'true',
  };
}

/** The secret the agents' tokens are derived from. */
function agentSecret(env: Environment): string {
  const secret = required(
    env,
    'SANDBOX_AGENT_SECRET',
    'the secret the tokens of the sandboxes’ agents are derived from, 32 characters at least',
  );
  if (secret.length < 32) throw new Error('SANDBOX_AGENT_SECRET: 32 characters at least.');
  return secret;
}

/**
 * The service's settings, from the environment. The sandboxes' image, zone, agent secret and egress
 * proxy are required; everything else has a default.
 */
export async function sandboxesConfig(env: Environment, logger: Logger): Promise<ServiceOptions> {
  const project = nonEmpty(env['SANDBOX_PROJECT']) ?? (await metadataProject());
  const zone = required(env, 'SANDBOX_ZONE', 'the zone of the sandboxes, such as europe-west1-b');
  const auth = (env['COMPUTE_AUTH'] ?? (onCloudRun(env) ? 'metadata' : 'gcloud')) as ComputeAuth;
  if (env['SANDBOX_SPOT'] === 'true') {
    logger.info('SANDBOX_SPOT=true: Compute Engine may stop a sandbox at any time.');
  }
  return {
    compute: new ComputeApi({
      endpoint: env['COMPUTE_API_URL'] ?? 'https://compute.googleapis.com/compute/v1',
      project,
      zone,
      token: new AccessToken(auth),
    }),
    proxy: new ProxyAdmin(
      required(env, 'SANDBOX_PROXY_ADMIN_URL', 'the administration API of the egress proxy'),
      required(env, 'SANDBOX_PROXY_TOKEN', 'the token of the egress proxy'),
    ),
    logger,
    zone,
    machine: machineSettings(env, project),
    instancePrefix: env['SANDBOX_INSTANCE_PREFIX'] ?? 'sbx-',
    agentSecret: agentSecret(env),
    agentPort: Number.parseInt(env['SANDBOX_AGENT_PORT'] ?? String(DEFAULT_AGENT_PORT), 10),
    proxyUrl: required(env, 'SANDBOX_PROXY_URL', 'the egress proxy, as the sandboxes reach it'),
    network: {
      allowedHosts: list(env['SANDBOX_ALLOWED_HOSTS']),
      baseUrls: baseUrls(env['SANDBOX_BASE_URLS']),
    },
    startTimeoutMs: Number.parseInt(env['SANDBOX_START_TIMEOUT'] ?? '300', 10) * 1000,
    serviceToken: nonEmpty(env['SANDBOX_SERVICE_TOKEN']),
  };
}

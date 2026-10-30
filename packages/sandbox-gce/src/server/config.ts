import type { Logger } from '../common/logger.js';
import type { ServiceOptions } from './http/sandbox-server.js';
import type { MachineSettings } from './sandboxes/sandboxes.js';

import { DEFAULT_AGENT_PORT } from '../protocol/agent.js';
import { DEFAULT_BASE_URLS } from '../protocol/proxy-routes.js';
import { AccessToken, type ComputeAuth } from './compute/access-token.js';
import { ComputeApi } from './compute/compute-api.js';
import { ProxyAdmin } from './sandboxes/proxy-admin.js';
import { DEFAULT_IMAGE } from './sandboxes/sandboxes.js';

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

/** A name callers pick an image by: what a label value takes. */
const IMAGE_NAME = /^[a-z][a-z0-9_-]{0,62}$/;

/**
 * The images the service offers: `SANDBOX_IMAGE` as `default`, and the `NAME=image` pairs of
 * `SANDBOX_IMAGES`, one per toolchain say: `python=family/sandbox-python,go=family/sandbox-go`.
 */
function images(env: Environment, project: string): Record<string, string> {
  const offered: Record<string, string> = {
    [DEFAULT_IMAGE]: imagePath(
      required(env, 'SANDBOX_IMAGE', 'the image of the sandboxes, a name or a family'),
      project,
    ),
  };
  for (const entry of list(env['SANDBOX_IMAGES'])) {
    const at = entry.indexOf('=');
    const name = entry.slice(0, at);
    if (at < 1 || !IMAGE_NAME.test(name)) {
      throw new Error(`SANDBOX_IMAGES: \`${entry}\` is not NAME=image, NAME in lowercase letters.`);
    }
    offered[name] = imagePath(entry.slice(at + 1), project);
  }
  return offered;
}

/** What the sandboxes' machines are made of. */
function machineSettings(env: Environment, project: string): MachineSettings {
  return {
    machineType: env['SANDBOX_MACHINE_TYPE'] ?? 'e2-standard-4',
    images: images(env, project),
    diskSizeGb: Number.parseInt(env['SANDBOX_DISK_GB'] ?? '20', 10),
    diskType: env['SANDBOX_DISK_TYPE'] ?? 'pd-balanced',
    network: nonEmpty(env['SANDBOX_NETWORK']),
    subnetwork: nonEmpty(env['SANDBOX_SUBNETWORK']),
    tags: list(env['SANDBOX_NETWORK_TAGS'] ?? 'ai-sdk-sandbox'),
    spot: env['SANDBOX_SPOT'] === 'true',
    spotFallback: env['SANDBOX_SPOT_FALLBACK'] !== 'false',
    maxRunSeconds: maxRunSeconds(env['SANDBOX_MAX_RUN_HOURS']),
  };
}

/**
 * `SANDBOX_MAX_RUN_HOURS`, the longest a machine runs at a time, in seconds: no limit when unset.
 * Compute Engine takes 30 s at least.
 */
function maxRunSeconds(value: string | undefined): number | undefined {
  const text = nonEmpty(value);
  if (text === undefined) return undefined;
  const hours = Number(text);
  if (!Number.isFinite(hours) || hours * 3600 < 30) {
    throw new Error(`SANDBOX_MAX_RUN_HOURS: \`${text}\` is not a number of hours, 30 s at least.`);
  }
  return Math.round(hours * 3600);
}

/** `SANDBOX_MAX_RUNNING`, a positive integer: no limit when unset. */
function maxRunning(value: string | undefined): number | undefined {
  const text = nonEmpty(value);
  if (text === undefined) return undefined;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`SANDBOX_MAX_RUNNING: \`${text}\` is not a positive integer.`);
  }
  return parsed;
}

/** `SANDBOX_RECONCILE_MINUTES`: 10 when unset, `0` for never. */
function reconcileEveryMs(value: string | undefined): number | undefined {
  const text = nonEmpty(value) ?? '10';
  const minutes = Number(text);
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`SANDBOX_RECONCILE_MINUTES: \`${text}\` is not a number of minutes.`);
  }
  return minutes === 0 ? undefined : minutes * 60_000;
}

/**
 * What `SANDBOX_PROFILE` sets the defaults of: `cost`, nothing running but the sandboxes, each
 * booted on demand; `fast`, a machine of the warm pool always booted and the proxy always on, for a
 * sandbox in seconds at a fixed cost.
 */
const PROFILES = {
  cost: { warmPool: 0, proxyAlwaysOn: false },
  fast: { warmPool: 1, proxyAlwaysOn: true },
} as const;

/** `SANDBOX_PROFILE`, `cost` or `fast`: `cost` when unset. */
function profile(value: string | undefined): (typeof PROFILES)[keyof typeof PROFILES] {
  const text = nonEmpty(value) ?? 'cost';
  if (text !== 'cost' && text !== 'fast') {
    throw new Error(`SANDBOX_PROFILE: \`${text}\` is neither \`cost\` nor \`fast\`.`);
  }
  return PROFILES[text];
}

/** `SANDBOX_WARM_POOL`, a whole number of machines: `fallback` when unset. */
function warmPool(value: string | undefined, fallback: number): number {
  const text = nonEmpty(value);
  if (text === undefined) return fallback;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`SANDBOX_WARM_POOL: \`${text}\` is not a whole number of machines.`);
  }
  return parsed;
}

/** A variable that is `true` or `false`: `fallback` when unset. */
function flag(name: string, value: string | undefined, fallback: boolean): boolean {
  const text = nonEmpty(value);
  if (text === undefined) return fallback;
  if (text !== 'true' && text !== 'false') {
    throw new Error(`${name}: \`${text}\` is neither \`true\` nor \`false\`.`);
  }
  return text === 'true';
}

/** The settings `SANDBOX_PROFILE` gives the defaults of, with a word on the cost of a warm pool. */
function speedSettings(
  env: Environment,
  logger: Logger,
): { warmPool: number; proxyAlwaysOn: boolean } {
  const defaults = profile(env['SANDBOX_PROFILE']);
  const pool = warmPool(env['SANDBOX_WARM_POOL'], defaults.warmPool);
  if (pool > 0) {
    logger.info(
      `SANDBOX_WARM_POOL=${pool}: ${pool === 1 ? 'a machine is' : `${pool} machines are`} kept booted from each template in use, billed all the time.`,
    );
  }
  return {
    warmPool: pool,
    proxyAlwaysOn: flag(
      'SANDBOX_PROXY_ALWAYS_ON',
      env['SANDBOX_PROXY_ALWAYS_ON'],
      defaults.proxyAlwaysOn,
    ),
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
 * `SANDBOX_SERVICE_TOKEN`. Required on Cloud Run, where a service deployed open by mistake would
 * let anyone run commands in the sandboxes, unless `SANDBOX_INSECURE_NO_TOKEN=true` says to go
 * without.
 */
function serviceToken(env: Environment, logger: Logger): string | undefined {
  const token = nonEmpty(env['SANDBOX_SERVICE_TOKEN']);
  if (token !== undefined || !onCloudRun(env)) return token;
  if (env['SANDBOX_INSECURE_NO_TOKEN'] !== 'true') {
    throw new Error(
      'SANDBOX_SERVICE_TOKEN is required on Cloud Run: a second lock beside its IAM, should the service ever be deployed open. Set SANDBOX_INSECURE_NO_TOKEN=true to go without.',
    );
  }
  logger.warn('SANDBOX_INSECURE_NO_TOKEN=true: Cloud Run’s IAM is the only lock of the service.');
  return undefined;
}

/** `SANDBOX_ALLOWED_HOSTS`, with a warning when it lets every sandbox reach any host. */
function allowedHosts(env: Environment, logger: Logger): string[] {
  const hosts = list(env['SANDBOX_ALLOWED_HOSTS']);
  if (hosts.includes('*')) {
    logger.warn(
      'SANDBOX_ALLOWED_HOSTS holds `*`: every sandbox may reach any host over HTTPS, and send its files there.',
    );
  }
  return hosts;
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
      allowedHosts: allowedHosts(env, logger),
      baseUrls: baseUrls(env['SANDBOX_BASE_URLS']),
    },
    startTimeoutMs: Number.parseInt(env['SANDBOX_START_TIMEOUT'] ?? '300', 10) * 1000,
    maxRunning: maxRunning(env['SANDBOX_MAX_RUNNING']),
    reconcileEveryMs: reconcileEveryMs(env['SANDBOX_RECONCILE_MINUTES']),
    proxyInstance: nonEmpty(env['SANDBOX_PROXY_INSTANCE']),
    ...speedSettings(env, logger),
    serviceToken: serviceToken(env, logger),
  };
}

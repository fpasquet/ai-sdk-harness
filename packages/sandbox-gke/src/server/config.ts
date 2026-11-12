import type { Logger } from '../common/logger.js';
import type { ServiceOptions } from './http/sandbox-server.js';
import type { PodSettings } from './sandboxes/sandboxes.js';

import { DEFAULT_AGENT_PORT } from '../protocol/agent.js';
import { DEFAULT_BASE_URLS } from '../protocol/proxy-routes.js';
import { type KubernetesAuth, KubernetesCredentials } from './kubernetes/credentials.js';
import { KubernetesApi } from './kubernetes/kubernetes-api.js';
import { proxyAddress } from './sandboxes/proxy-address.js';
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

/** `NAME=value,NAME=value` as pairs, `what` naming the variable in errors. */
function pairs(raw: string | undefined, what: string): [string, string][] {
  return list(raw).map((entry) => {
    const at = entry.indexOf('=');
    if (at < 1) throw new Error(`${what}: \`${entry}\` is not NAME=value.`);
    return [entry.slice(0, at), entry.slice(at + 1)];
  });
}

/** Kubernetes sets `KUBERNETES_SERVICE_HOST` in every pod. */
const inCluster = (env: Environment): boolean => env['KUBERNETES_SERVICE_HOST'] !== undefined;

function required(env: Environment, name: string, why: string): string {
  const value = nonEmpty(env[name]);
  if (value === undefined) throw new Error(`${name} is required: ${why}.`);
  return value;
}

/** A secret of 32 characters at least. */
function secret(env: Environment, name: string, why: string): string {
  const value = required(env, name, `${why}, 32 characters at least`);
  if (value.length < 32) throw new Error(`${name}: 32 characters at least.`);
  return value;
}

/** Where the service listens: every interface in a cluster, the loopback anywhere else. */
export function listenConfig(env: Environment): ListenConfig {
  return {
    port: Number.parseInt(env['PORT'] ?? '8080', 10),
    host: env['HOST'] ?? (inCluster(env) ? '0.0.0.0' : '127.0.0.1'),
    jsonLogs: (env['LOG_FORMAT'] ?? (inCluster(env) ? 'json' : 'text')) === 'json',
  };
}

/** A name callers pick an image by: what a label value takes. */
const IMAGE_NAME = /^[a-z][a-z0-9_-]{0,62}$/;

/**
 * The images the service offers: `SANDBOX_IMAGE` as `default`, and the `NAME=image` pairs of
 * `SANDBOX_IMAGES`, one per toolchain say: `python=europe-docker.pkg.dev/p/r/sandbox-python@sha256:…`.
 */
function images(env: Environment): Record<string, string> {
  const offered: Record<string, string> = {
    [DEFAULT_IMAGE]: required(env, 'SANDBOX_IMAGE', 'the container image of the sandboxes'),
  };
  for (const [name, image] of pairs(env['SANDBOX_IMAGES'], 'SANDBOX_IMAGES')) {
    if (!IMAGE_NAME.test(name)) {
      throw new Error(`SANDBOX_IMAGES: \`${name}\` is no image name: lowercase letters first.`);
    }
    offered[name] = image;
  }
  return offered;
}

/** What the sandboxes' pods are made of. */
function podSettings(env: Environment): PodSettings {
  return {
    images: images(env),
    // `SANDBOX_RUNTIME_CLASS=` (empty) for none: a cluster without GKE Sandbox, never production.
    runtimeClassName: nonEmpty(env['SANDBOX_RUNTIME_CLASS'] ?? 'gvisor'),
    serviceAccountName: nonEmpty(env['SANDBOX_SERVICE_ACCOUNT']),
    cpu: env['SANDBOX_CPU'] ?? '2',
    memory: env['SANDBOX_MEMORY'] ?? '4Gi',
    ephemeralStorage: env['SANDBOX_EPHEMERAL_STORAGE'] ?? '10Gi',
    volumeSize: env['SANDBOX_VOLUME_SIZE'] ?? '20Gi',
    storageClassName: nonEmpty(env['SANDBOX_STORAGE_CLASS']),
    snapshotClassName: nonEmpty(env['SANDBOX_SNAPSHOT_CLASS']),
    uid: Number.parseInt(env['SANDBOX_UID'] ?? '1000', 10),
    home: env['SANDBOX_HOME'] ?? '/home/agent',
  };
}

/** The Kubernetes API, as the service's pod reaches it. */
function kubernetesApi(env: Environment): KubernetesApi {
  const auth = (env['KUBERNETES_AUTH'] ??
    (inCluster(env) ? 'service-account' : 'none')) as KubernetesAuth;
  const credentials = new KubernetesCredentials(auth);
  const endpoint =
    nonEmpty(env['KUBERNETES_API_URL']) ??
    (inCluster(env)
      ? `https://${env['KUBERNETES_SERVICE_HOST']}:${env['KUBERNETES_SERVICE_PORT'] ?? '443'}`
      : 'http://127.0.0.1:8001');
  const namespace =
    nonEmpty(env['SANDBOX_NAMESPACE']) ??
    credentials.namespace() ??
    required(env, 'SANDBOX_NAMESPACE', 'the namespace of the sandboxes');
  return new KubernetesApi({ endpoint, namespace, credentials });
}

/**
 * The service's settings, from the environment. The sandboxes' image, the agents' secret, the
 * service's token and the egress proxy are required; everything else has a default, the namespace
 * the service's own.
 */
export function sandboxesConfig(env: Environment, logger: Logger): ServiceOptions {
  const pod = podSettings(env);
  if (pod.runtimeClassName !== 'gvisor') {
    logger.warn('The sandboxes do not run under gVisor: their pods share the nodes’ kernel.');
  }
  return {
    kubernetes: kubernetesApi(env),
    proxy: new ProxyAdmin(
      required(env, 'SANDBOX_PROXY_ADMIN_URL', 'the administration API of the egress proxy'),
      required(env, 'SANDBOX_PROXY_TOKEN', 'the token of the egress proxy'),
    ),
    logger,
    pod,
    namePrefix: env['SANDBOX_NAME_PREFIX'] ?? 'sbx-',
    agentSecret: secret(
      env,
      'SANDBOX_AGENT_SECRET',
      'the secret the tokens of the sandboxes’ agents are derived from',
    ),
    agentPort: Number.parseInt(env['SANDBOX_AGENT_PORT'] ?? String(DEFAULT_AGENT_PORT), 10),
    proxyUrl: proxyAddress(
      required(env, 'SANDBOX_PROXY_URL', 'the egress proxy, as the sandboxes reach it'),
    ),
    network: {
      allowedHosts: list(env['SANDBOX_ALLOWED_HOSTS']),
      baseUrls:
        env['SANDBOX_BASE_URLS'] === undefined
          ? { ...DEFAULT_BASE_URLS }
          : Object.fromEntries(pairs(env['SANDBOX_BASE_URLS'], 'SANDBOX_BASE_URLS')),
    },
    startTimeoutMs: Number.parseInt(env['SANDBOX_START_TIMEOUT'] ?? '300', 10) * 1000,
    snapshotTimeoutMs: Number.parseInt(env['SANDBOX_SNAPSHOT_TIMEOUT'] ?? '600', 10) * 1000,
    serviceToken: secret(
      env,
      'SANDBOX_SERVICE_TOKEN',
      'the secret every call to the service carries, nothing else guarding it',
    ),
  };
}

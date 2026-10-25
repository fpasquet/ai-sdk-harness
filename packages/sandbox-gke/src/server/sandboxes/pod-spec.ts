/** What every sandbox's pod is made of: the service's to give. */
export interface PodSettings {
  /**
   * The container images the pods run, by the name callers pick them with, `default` the one they
   * get without: one per toolchain, say. Each runs `ai-sdk-sandbox-gke agent`.
   */
  images: Readonly<Record<string, string>>;
  /** `gvisor`, which GKE Sandbox runs pods under; none for a cluster without it, tests only. */
  runtimeClassName?: string;
  /** The service account of the pods: one that is granted nothing. */
  serviceAccountName?: string;
  /** What a pod is given and held to: Kubernetes quantities, `2`, `4Gi`. */
  cpu: string;
  memory: string;
  /** The room its root filesystem may take, beside its volume. */
  ephemeralStorage: string;
  /** The size of each sandbox's home volume, kept while it is suspended: `20Gi`. */
  volumeSize: string;
  /** The storage class of the volumes: the cluster's default without it. */
  storageClassName?: string;
  /** The class of the templates' snapshots: the cluster's default without it. */
  snapshotClassName?: string;
  /** The user and group the pod runs as, never root. */
  uid: number;
  /** The sandbox's user's home, on its volume: the working directory is under it. */
  home: string;
}

/** The name of a sandbox's volume: its claim is `home-<sandbox>`. */
export const VOLUME = 'home';

/** The node label and taint of GKE Sandbox's node pools. */
const GVISOR_NODES = 'sandbox.gke.io/runtime';

/** Where the pod may run: GKE Sandbox's nodes under gVisor, which require naming them. */
function runtime(settings: PodSettings): Record<string, unknown> {
  if (settings.runtimeClassName === undefined) return {};
  if (settings.runtimeClassName !== 'gvisor')
    return { runtimeClassName: settings.runtimeClassName };
  return {
    runtimeClassName: 'gvisor',
    nodeSelector: { [GVISOR_NODES]: 'gvisor' },
    tolerations: [{ key: GVISOR_NODES, operator: 'Equal', value: 'gvisor', effect: 'NoSchedule' }],
  };
}

/** The container of the pod: the agent, its token, its volume, held to its limits. */
function agentContainer(
  settings: PodSettings,
  { image, agentPort, agentToken }: { agentPort: number; agentToken: string; image: string },
): Record<string, unknown> {
  const resources = {
    cpu: settings.cpu,
    memory: settings.memory,
    'ephemeral-storage': settings.ephemeralStorage,
  };
  return {
    name: 'sandbox',
    image,
    command: ['ai-sdk-sandbox-gke', 'agent'],
    env: [
      { name: 'SANDBOX_AGENT_TOKEN', value: agentToken },
      { name: 'SANDBOX_AGENT_PORT', value: String(agentPort) },
      { name: 'SANDBOX_HOME', value: settings.home },
      { name: 'SANDBOX_WORKDIR', value: `${settings.home}/workspace` },
      { name: 'SANDBOX_STATE_DIR', value: '/tmp/ai-sdk-sandbox' },
    ],
    ports: [{ name: 'agent', containerPort: agentPort }],
    readinessProbe: { httpGet: { path: '/health', port: agentPort }, periodSeconds: 1 },
    resources: { requests: resources, limits: resources },
    securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
    volumeMounts: [{ name: VOLUME, mountPath: settings.home }],
  };
}

/**
 * The pod of a sandbox: its agent, as the sandbox's user; nothing of the cluster's in reach. The
 * settings GKE Sandbox requires are all there: gVisor, no service account token, not root, every
 * capability dropped, limits.
 */
export function podSpec(
  settings: PodSettings,
  container: { agentPort: number; agentToken: string; image: string },
): Record<string, unknown> {
  return {
    ...runtime(settings),
    ...(settings.serviceAccountName === undefined
      ? {}
      : { serviceAccountName: settings.serviceAccountName }),
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    // No resolver: the commands reach nothing but the egress proxy, by its address, which resolves
    // for them. A name fails at once, rather than after the network policy drops the query.
    dnsPolicy: 'None',
    dnsConfig: { nameservers: ['127.0.0.1'] },
    securityContext: {
      runAsNonRoot: true,
      runAsUser: settings.uid,
      runAsGroup: settings.uid,
      fsGroup: settings.uid,
      seccompProfile: { type: 'RuntimeDefault' },
    },
    containers: [agentContainer(settings, container)],
  };
}

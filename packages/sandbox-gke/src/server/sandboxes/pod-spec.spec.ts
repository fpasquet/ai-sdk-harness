import { describe, expect, it } from 'vitest';

import type { PodSettings } from './pod-spec.js';

import { podSpec } from './pod-spec.js';

const settings: PodSettings = {
  images: { default: 'sandbox@sha256:abc' },
  cpu: '2',
  memory: '4Gi',
  ephemeralStorage: '10Gi',
  volumeSize: '20Gi',
  uid: 1000,
  home: '/home/agent',
};
const container = { agentPort: 8100, agentToken: 'a-token', image: 'sandbox@sha256:abc' };

describe('the pod of a sandbox', () => {
  it('runs under gVisor on the nodes of GKE Sandbox, which have to be named', () => {
    expect(podSpec({ ...settings, runtimeClassName: 'gvisor' }, container)).toMatchObject({
      runtimeClassName: 'gvisor',
      nodeSelector: { 'sandbox.gke.io/runtime': 'gvisor' },
      tolerations: [{ key: 'sandbox.gke.io/runtime', value: 'gvisor', effect: 'NoSchedule' }],
    });
  });

  it('takes another runtime class as it is, and none without one', () => {
    const kata = podSpec({ ...settings, runtimeClassName: 'kata' }, container);
    const plain = podSpec({ ...settings, serviceAccountName: 'sandbox' }, container);

    expect(kata).toMatchObject({ runtimeClassName: 'kata' });
    expect(kata).not.toHaveProperty('nodeSelector');
    expect(plain).not.toHaveProperty('runtimeClassName');
    expect(plain).toMatchObject({
      serviceAccountName: 'sandbox',
      automountServiceAccountToken: false,
    });
  });
});

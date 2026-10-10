import { fileURLToPath } from 'node:url';

import { vitestConfig } from '@repo/vitest-config';

// Unit tests never boot a microVM: `microsandbox` resolves to a fake SDK that runs commands on
// this host, in a temporary directory per sandbox.
export default vitestConfig({
  resolve: {
    alias: { microsandbox: fileURLToPath(new URL('./test/fake-microsandbox.ts', import.meta.url)) },
  },
});

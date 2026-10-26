/**
 * `pnpm template`: makes the template of the example's sandbox ahead of its first conversation, on
 * Cloud Run or Compute Engine (`EXAMPLE_SANDBOX`), where making it takes minutes. Reads
 * `.env.local`, as the example does. Run it after each deploy that changes the harnesses or the
 * sandbox image.
 */
import { createHarnessSandboxTemplate } from '@ai-sdk/harness/agent';

import { adapterOf } from '@/lib/harness-adapters';
import { TEMPLATE_HARNESSES } from '@/lib/harnesses';
import { prepareSandboxTemplate, SANDBOX } from '@/lib/sandbox';

const startedAt = Date.now();
process.stdout.write(
  `Making the template of the ${SANDBOX} sandbox: ${TEMPLATE_HARNESSES.join(', ')}…\n`,
);
await prepareSandboxTemplate(() =>
  createHarnessSandboxTemplate({ harnesses: TEMPLATE_HARNESSES.map(adapterOf) }),
);
process.stdout.write(`Ready in ${Math.round((Date.now() - startedAt) / 1000)} s.\n`);

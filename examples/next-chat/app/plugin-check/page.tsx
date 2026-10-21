import { PluginChecker } from '@/components/plugin-checker';
import { checkSamples } from '@/lib/plugin-check';

// The marketplace's files are read as they are now, not as they were at build time.
export const dynamic = 'force-dynamic';

/**
 * A plugin edited as JSON and checked as you type: what `definePlugin()` refuses, and what
 * `lintPlugin()` finds in what it accepts.
 */
export default async function Page() {
  return <PluginChecker kind="plugin" samples={await checkSamples('plugin')} />;
}

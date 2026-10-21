import { PluginChecker } from '@/components/plugin-checker';
import { pluginSamples } from '@/lib/plugin-check';

// The marketplace's files are read as they are now, not as they were at build time.
export const dynamic = 'force-dynamic';

/**
 * A plugin, or an item, edited as JSON and checked as you type: what `definePlugin()` and
 * `defineItem()` refuse, and what `lintPlugin()` and `lintItem()` find in what they accept.
 */
export default async function Page() {
  return <PluginChecker samples={await pluginSamples()} />;
}

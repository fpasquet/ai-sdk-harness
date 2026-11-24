import { PluginChecker } from '@/components/plugin-checker';
import { checkSamples } from '@/lib/plugin-check';

// The marketplace's files are read as they are now, not as they were at build time.
export const dynamic = 'force-dynamic';

/**
 * An item on its own — a tool, a command… — edited as JSON and checked as you type: what
 * `defineItem()` refuses, and what `lintItem()` finds in what it accepts.
 */
export default async function Page() {
  return <PluginChecker kind="item" samples={await checkSamples('item')} />;
}

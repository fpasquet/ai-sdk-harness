import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SITE_URL } from '@/lib/constants';

/**
 * The components of the registry, served at `/r/<name>.json` for `npx shadcn add`. Their source is
 * the Next.js example's, where they run against real sessions: what you install is what it shows.
 */
interface RegistryComponent {
  name: string;
  title: string;
  description: string;
  /** The file, relative to the example. */
  source: string;
  dependencies: string[];
  /** The shadcn/ui components it uses. */
  registryDependencies: string[];
}

const EXAMPLE_DIR = join(process.cwd(), '..', 'examples', 'next-chat');

export const REGISTRY_COMPONENTS: RegistryComponent[] = [
  {
    name: 'tool-approval',
    title: 'Tool approval',
    description:
      'The approval of a tool call of a harness agent: what it does, Approve, Deny and Always allow while it waits, the verdict and its reason once given.',
    source: 'components/harness/tool-approval.tsx',
    dependencies: ['ai', 'ai-sdk-harness-approval', 'lucide-react'],
    registryDependencies: ['button'],
  },
  {
    name: 'questions-form',
    title: 'Questions form',
    description:
      'The questions a harness agent asks, askUserQuestions: options to pick, a free answer, and the answers once given.',
    source: 'components/harness/questions-form.tsx',
    dependencies: ['ai-sdk-harness-approval', 'lucide-react'],
    registryDependencies: ['button', 'input'],
  },
];

const fileName = (source: string): string => source.slice(source.lastIndexOf('/') + 1);

/** A component as a shadcn registry item, its source inlined. */
export async function registryItem(component: RegistryComponent) {
  const { dependencies, description, name, registryDependencies, source, title } = component;
  return {
    $schema: 'https://ui.shadcn.com/schema/registry-item.json',
    name,
    type: 'registry:component',
    title,
    description,
    dependencies,
    registryDependencies,
    files: [
      {
        path: `registry/${fileName(source)}`,
        type: 'registry:component',
        target: `components/harness/${fileName(source)}`,
        content: await readFile(join(EXAMPLE_DIR, source), 'utf8'),
      },
    ],
  };
}

/** The registry's index, `/r/registry.json`. */
export function registryIndex() {
  return {
    $schema: 'https://ui.shadcn.com/schema/registry.json',
    name: 'ai-sdk-harness',
    homepage: SITE_URL,
    items: REGISTRY_COMPONENTS.map(
      ({ dependencies, description, name, registryDependencies, source, title }) => ({
        name,
        type: 'registry:component',
        title,
        description,
        dependencies,
        registryDependencies,
        files: [{ path: `registry/${fileName(source)}`, type: 'registry:component' }],
      }),
    ),
  };
}

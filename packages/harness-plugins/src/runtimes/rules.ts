import type { Plugin } from '../definitions/plugin.js';

/**
 * The rules of `plugins` as the agent's instructions, on every runtime: each under its name, one
 * with `paths` saying which files it is for. `undefined` without rules.
 */
export function rulesAsInstructions(plugins: readonly Plugin[]): string | undefined {
  const rules = plugins.flatMap((plugin) => plugin.rules ?? []);
  if (rules.length === 0) return undefined;
  const sections = rules.map(({ name, paths, content }) => {
    const scope =
      paths === undefined
        ? ''
        : `Only for the files matching ${paths.map((path) => `\`${path}\``).join(', ')}.\n\n`;
    return `## ${name}\n\n${scope}${content.trim()}`;
  });
  return `# Rules\n\nFollow these rules of the project.\n\n${sections.join('\n\n')}`;
}

import type { Plugin, PluginRule } from '../definitions/plugin.js';
import type { SessionFile } from './plugin-runtime.js';

import { stringifyFrontmatter } from '../utils/frontmatter.js';

/**
 * A rule as Claude Code reads it, in `.claude/rules/<plugin>/`: its `paths` in the frontmatter,
 * the only field Claude Code reads there.
 */
export function ruleFile(plugin: string, rule: PluginRule): SessionFile {
  return {
    path: `.claude/rules/${plugin}/${rule.name}.md`,
    content:
      rule.paths === undefined
        ? `${rule.content.trim()}\n`
        : stringifyFrontmatter({ paths: rule.paths }, rule.content),
  };
}

/**
 * The rules of `plugins` as instructions, for a runtime that has no rules of its own: each under
 * its name, one with `paths` saying which files it is for. `undefined` without rules.
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

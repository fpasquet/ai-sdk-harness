/**
 * The tools every runtime has under names of its own, by the name an eval may give them: the
 * common name of `@ai-sdk/harness`, then the native names of Claude Code and Codex.
 */
const SAME_TOOLS: readonly (readonly string[])[] = [
  ['bash', 'Bash', 'shell'],
  ['read', 'Read'],
  ['write', 'Write'],
  ['edit', 'Edit', 'MultiEdit', 'apply_patch'],
  ['glob', 'Glob'],
  ['grep', 'Grep'],
  ['webSearch', 'WebSearch', 'web_search'],
  ['webFetch', 'WebFetch'],
];

/** The names a tool may have in the stream: its own, and those of the same tool on other runtimes. */
export function namesOf(tool: string): readonly string[] {
  return SAME_TOOLS.find((names) => names.includes(tool)) ?? [tool];
}

/** Whether a call to `called` is one to `tool`, whatever the runtime names it. */
export const isTool = (called: string, tool: string): boolean => namesOf(tool).includes(called);

/** The tool that loads a skill, on Claude Code, and the input key that names the skill. */
const SKILL_TOOL = { name: 'Skill', key: 'skill' } as const;

/** A skill's file, as a runtime reads it to load the skill (Codex: `~/.agents/skills/<name>/`). */
const SKILL_FILE = /skills\/([^/\s'"]+)\/SKILL\.md/g;

/** The skills a tool call loads: Claude Code's `Skill` tool, or a read of their `SKILL.md`. */
export function skillsLoadedBy(name: string, input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return [];
  const fields = input as Record<string, unknown>;
  if (name === SKILL_TOOL.name) {
    const skill = fields[SKILL_TOOL.key];
    return typeof skill === 'string' ? [skill] : [];
  }
  return Object.values(fields)
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => [...value.matchAll(SKILL_FILE)].flatMap(([, skill]) => skill ?? []));
}

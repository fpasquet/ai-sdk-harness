import { definePlugin } from 'ai-sdk-harness-plugins';

/**
 * What the agent gets on top of Claude Code, with ai-sdk-harness-plugins: a skill it loads when it
 * reviews code, and a `/review` command that asks for one.
 */
export const plugin = definePlugin({
  name: 'starter',
  description: 'Reviews the changes of the agent.',
  skills: [
    {
      name: 'code-review',
      description: 'How to review a change. Use it whenever you review code or a diff.',
      content: `# Reviewing a change

1. Say what the change does, in one sentence.
2. List the bugs first: what breaks, with the file and the line.
3. Then what is hard to read or to change, and why.`,
    },
  ],
  commands: [
    {
      name: 'review',
      description: 'Review the uncommitted changes',
      prompt:
        'Review the uncommitted changes of the repository (git diff), with the code-review skill. $ARGUMENTS',
    },
  ],
});

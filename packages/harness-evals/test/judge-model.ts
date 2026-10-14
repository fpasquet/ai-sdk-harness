import { MockLanguageModelV4 } from 'ai/test';

/** A judge model that answers each request with the next verdict, and keeps the prompts it read. */
export function judgeModel(
  ...verdicts: (Error | { score: number; reason: string })[]
): MockLanguageModelV4 & { prompts: string[] } {
  const prompts: string[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: ({ prompt }) => {
      prompts.push(JSON.stringify(prompt));
      const verdict = verdicts.shift() ?? { score: 1, reason: 'Fine.' };
      if (verdict instanceof Error) return Promise.reject(verdict);
      return Promise.resolve({
        content: [{ type: 'text', text: JSON.stringify(verdict) }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      });
    },
  });
  return Object.assign(model, { prompts });
}

/**
 * The coding agents the example can run, and the models each one offers. Shared by the page, which
 * lets you pick one, and the route, which only accepts what is listed here.
 */
export const HARNESSES = {
  'claude-code': {
    label: 'Claude Code',
    models: [
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    ],
  },
  codex: {
    label: 'Codex',
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
    ],
  },
} as const;

export type HarnessId = keyof typeof HARNESSES;

export const HARNESS_IDS = Object.keys(HARNESSES) as HarnessId[];

/** The model a conversation starts with: the first, and cheapest, of its harness. */
export const defaultModel = (harness: HarnessId): string => HARNESSES[harness].models[0].id;

/** Whether `harness` and `model` name an agent of the catalog. */
export function isKnown(harness: unknown, model: unknown): harness is HarnessId {
  return (
    typeof harness === 'string' &&
    harness in HARNESSES &&
    HARNESSES[harness as HarnessId].models.some(({ id }) => id === model)
  );
}

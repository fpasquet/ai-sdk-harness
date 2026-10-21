/** The variable a `sandbox-command` reads a property of its input from: `max_count` → `INPUT_MAX_COUNT`. */
export const inputVariable = (key: string): string =>
  `INPUT_${key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;

/** What a `sandbox-command`, or a script it runs, reads of its input. */
export interface CitedInputVariables {
  /** Whether it reads `INPUT`, the whole input as JSON. */
  all: boolean;
  /** The `INPUT_<KEY>` variables it reads, each once: `$INPUT_X`, `${INPUT_X:-…}`, `printenv INPUT_X`… */
  names: string[];
}

/**
 * What `text` — a command, or a script it runs — reads of the input: `INPUT`, and the `INPUT_<KEY>`
 * variables, with or without a `$`, but not those it sets itself (`INPUT_DIR=/tmp`).
 */
export function citedInputVariables(text: string): CitedInputVariables {
  const assigned = new Set(
    [...text.matchAll(/(?<![\w${])(INPUT_\w+)=/g)].map(([, name]) => name as string),
  );
  const names = new Set(
    [...text.matchAll(/(?<!\w)(INPUT_\w+)/g)]
      .map(([, name]) => name as string)
      .filter((name) => !assigned.has(name)),
  );
  return { all: /(?<!\w)INPUT(?!\w)/.test(text), names: [...names] };
}

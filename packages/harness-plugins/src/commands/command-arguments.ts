/** `$ARGUMENTS`, or one of `$1` to `$9`: what {@link citedArguments} and `expandCommand` read. */
export const ARGUMENT = /\$ARGUMENTS|\$([1-9])/g;

/** What the prompt of a command reads of its arguments. */
export interface CitedArguments {
  /** Whether it reads `$ARGUMENTS`, everything after the name. */
  all: boolean;
  /** The positions of the `$1` to `$9` it reads, in order, each once. */
  positions: number[];
}

/**
 * What `prompt` reads of a command's arguments: `$ARGUMENTS`, and `$1` to `$9`. When it reads
 * neither, `expandCommand` appends the arguments to it.
 */
export function citedArguments(prompt: string): CitedArguments {
  const positions = new Set<number>();
  let all = false;
  for (const [, position] of prompt.matchAll(ARGUMENT)) {
    if (position === undefined) all = true;
    else positions.add(Number(position));
  }
  return { all, positions: [...positions].sort((a, b) => a - b) };
}

/**
 * How many arguments `hint` announces, each `<…>` or `[…]`: `Infinity` when the last one takes
 * the rest (`[files...]`), `undefined` when it is free text, which cannot be counted.
 */
export function hintedArguments(hint: string): number | undefined {
  // Neither bracket inside a group: a hint of `<` after `<` is read in linear time.
  const groups = [...hint.matchAll(/<[^<>]*>|\[[^[\]]*\]/g)].map(([group]) => group);
  if (groups.length === 0) return undefined;
  return /\.\.\.|…/.test(groups.at(-1) ?? '') ? Infinity : groups.length;
}

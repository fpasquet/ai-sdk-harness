/**
 * A TOML document of string keys and values, one `key = "value"` per line, in the order given; an
 * `undefined` value is left out. Keys must be bare (letters, digits, `_`, `-`).
 */
export function stringifyToml(data: Record<string, string | undefined>): string {
  return Object.entries(data)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key} = ${tomlString(value)}\n`)
    .join('');
}

/**
 * A TOML basic string: JSON's escapes are TOML's, but for the DEL character, which TOML wants
 * escaped too, and a lone surrogate, which it refuses.
 */
function tomlString(value: string): string {
  return JSON.stringify(value.toWellFormed()).replaceAll('\u007f', '\\u007f');
}

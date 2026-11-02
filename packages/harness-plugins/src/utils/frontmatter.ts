/** A value of a frontmatter: a scalar, a list of them, or a map of them (`metadata`). */
export type FrontmatterValue = Record<string, string> | string | string[];

/** A Markdown document split into its frontmatter and its body. */
export interface FrontmatterDocument {
  data: Record<string, FrontmatterValue>;
  body: string;
}

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const KEY = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/;
const ITEM = /^[ \t]+-[ \t]+(.*)$/;
const NESTED = /^[ \t]+([A-Za-z0-9_.-]+):(?:[ \t]+(.*))?$/;

/**
 * Splits `text` into its YAML frontmatter and its body. Only what the Markdown files of Claude
 * Code plugins and skills use is read: `key: value`, quoted or not, inline lists (`[a, b]`), block
 * lists (`- a`) and maps of scalars one level deep (`metadata:` then `  version: "1.0"`). A
 * document without frontmatter has empty data.
 */
export function parseFrontmatter(text: string): FrontmatterDocument {
  const fence = FENCE.exec(text);
  if (fence === null) return { data: {}, body: text.trim() };
  return { data: parseData(fence[1] ?? ''), body: text.slice(fence[0].length).trim() };
}

function parseData(yaml: string): Record<string, FrontmatterValue> {
  const data: Record<string, FrontmatterValue> = {};
  // The key whose value is the block below it: a list, or a map.
  let open: string | undefined;
  for (const line of yaml.split(/\r?\n/)) {
    const entry = KEY.exec(line);
    if (entry !== null) {
      const [, key = '', raw = ''] = entry;
      open = raw.trim() === '' ? key : undefined;
      data[key] = open === undefined ? valueOf(raw.trim()) : [];
    } else if (open !== undefined) {
      data[open] = blockLine(data[open] ?? [], line);
    }
  }
  return data;
}

/** `block` with `line` added: an item to a list, a `key: value` to a map, as the block began. */
function blockLine(block: FrontmatterValue, line: string): FrontmatterValue {
  const item = ITEM.exec(line);
  if (item !== null) return Array.isArray(block) ? [...block, unquote(item[1] ?? '')] : block;
  const nested = NESTED.exec(line);
  const map = mapOf(block);
  if (nested === null || map === undefined) return block;
  const [, key = '', raw = ''] = nested;
  return { ...map, [key]: unquote(raw.trim()) };
}

/** The map a block is, or begins as when it is still empty. */
function mapOf(block: FrontmatterValue): Record<string, string> | undefined {
  if (isMap(block)) return block;
  return Array.isArray(block) && block.length === 0 ? {} : undefined;
}

/**
 * A Markdown document with `data` as its frontmatter. Every string is written as a JSON string,
 * which YAML reads back as the same string whatever it holds.
 */
export function stringifyFrontmatter(
  data: Record<string, string | string[] | undefined>,
  body: string,
): string {
  const lines = Object.entries(data).flatMap(([key, value]) => {
    if (value === undefined) return [];
    const written = Array.isArray(value)
      ? `[${value.map((item) => JSON.stringify(item)).join(', ')}]`
      : JSON.stringify(value);
    return [`${key}: ${written}`];
  });
  return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`;
}

/** The text of a frontmatter value as a list: `[a, b]`, or `a, b`. */
export function listOf(value: FrontmatterValue | undefined): string[] | undefined {
  if (value === undefined || isMap(value)) return undefined;
  const items = Array.isArray(value) ? value : value.split(',');
  return items.map((item) => item.trim()).filter((item) => item !== '');
}

/** Whether `value` is a map, rather than a scalar or a list. */
export const isMap = (value: FrontmatterValue | undefined): value is Record<string, string> =>
  typeof value === 'object' && !Array.isArray(value);

function valueOf(raw: string): FrontmatterValue {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw
      .slice(1, -1)
      .split(',')
      .map((item) => unquote(item.trim()))
      .filter((item) => item !== '');
  }
  return unquote(raw);
}

function unquote(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  return raw;
}

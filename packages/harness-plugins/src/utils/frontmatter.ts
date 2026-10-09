/** A value of a frontmatter: a scalar, or a list of them. */
export type FrontmatterValue = string | string[];

/** A Markdown document split into its frontmatter and its body. */
export interface FrontmatterDocument {
  data: Record<string, FrontmatterValue>;
  body: string;
}

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const KEY = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/;
const ITEM = /^[ \t]+-[ \t]+(.*)$/;

/**
 * Splits `text` into its YAML frontmatter and its body. Only what the Markdown files of Claude
 * Code plugins use is read: `key: value`, quoted or not, inline lists (`[a, b]`) and block lists
 * (`- a`). A document without frontmatter has empty data.
 */
export function parseFrontmatter(text: string): FrontmatterDocument {
  const fence = FENCE.exec(text);
  if (fence === null) return { data: {}, body: text.trim() };
  return { data: parseData(fence[1] ?? ''), body: text.slice(fence[0].length).trim() };
}

function parseData(yaml: string): Record<string, FrontmatterValue> {
  const data: Record<string, FrontmatterValue> = {};
  let list: string[] | undefined;
  for (const line of yaml.split(/\r?\n/)) {
    const item = ITEM.exec(line);
    const entry = KEY.exec(line);
    if (item !== null && list !== undefined) {
      list.push(unquote(item[1] ?? ''));
    } else if (entry !== null) {
      const [, key = '', raw = ''] = entry;
      list = raw.trim() === '' ? [] : undefined;
      data[key] = list ?? valueOf(raw.trim());
    }
  }
  return data;
}

/**
 * A Markdown document with `data` as its frontmatter. Every string is written as a JSON string,
 * which YAML reads back as the same string whatever it holds.
 */
export function stringifyFrontmatter(
  data: Record<string, FrontmatterValue | undefined>,
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
  if (value === undefined) return undefined;
  const items = Array.isArray(value) ? value : value.split(',');
  return items.map((item) => item.trim()).filter((item) => item !== '');
}

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

/** One simple command of a shell script, as approval rules read it. */
export interface CommandSegment {
  /** Its words, one space apart, quotes removed, leading variable assignments dropped. */
  command: string;
  /** Whether it writes to a file through a redirection, `>` or `>>`, other than `/dev/null`. */
  writes: boolean;
  /** The files its redirections write to, as the script names them. */
  files: string[];
}

/** A here-document opened on the current line: its body starts on the next one. */
interface HereDocument {
  delimiter: string;
  /** `<<-`: tabs before the delimiter are stripped. */
  stripTabs: boolean;
  /** `<<'EOF'`, `<<"EOF"`, `<<\EOF`: the body is taken as is, its substitutions not run. */
  quoted: boolean;
}

/** Shell words that open a command rather than name it: `if cmd`, `! cmd`, `{ cmd; }`… */
const KEYWORDS = new Set([
  '!',
  'case',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'if',
  'then',
  'time',
  'until',
  'while',
  '{',
  '}',
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const BLANK = /[ \t]/;

/** The words of a command, as rules match them: assignments and keywords dropped, `\rm` → `rm`. */
export function normalizeWords(words: readonly string[]): string {
  let start = 0;
  while (
    start < words.length &&
    (ASSIGNMENT.test(words[start] ?? '') || KEYWORDS.has(words[start] ?? ''))
  ) {
    start += 1;
  }
  const [head, ...rest] = words.slice(start).filter((word) => word !== '');
  if (head === undefined) return '';
  const name = head.replace(/^\\/, '');
  return [name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name, ...rest].join(' ');
}

/** Where a substitution `$(…)`, `<(…)` or `>(…)` opened at `open` closes. */
function closingParen(script: string, open: number): number {
  let depth = 1;
  for (let index = open + 1; index < script.length; index += 1) {
    if (script[index] === '(') depth += 1;
    if (script[index] === ')') depth -= 1;
    if (depth === 0) return index;
  }
  return script.length;
}

/** The substitutions the body of a here-document runs, its delimiter unquoted: not `\$(…)`. */
function substitutionsOf(body: string): CommandSegment[] {
  const found: CommandSegment[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\') {
      index += 1;
    } else if (char === '$' && body[index + 1] === '(') {
      const close = closingParen(body, index + 1);
      if (body[index + 2] !== '(') found.push(...commandSegments(body.slice(index + 2, close)));
      index = close;
    } else if (char === '`') {
      const close = body.indexOf('`', index + 1);
      const end = close === -1 ? body.length : close;
      found.push(...commandSegments(body.slice(index + 1, end)));
      index = end;
    }
  }
  return found;
}

/**
 * Reads a shell script into the simple commands it runs, so that `cd app && rm -rf /` is not
 * taken for `cd`. Command substitutions, `$(…)` and backquotes, count as commands of their own;
 * the body of a here-document is input, not script.
 * Approximate on purpose: a construct it misreads yields a command that matches no rule, which
 * the policy asks about.
 */
export function commandSegments(script: string): CommandSegment[] {
  return new ShellScanner(script).scan();
}

class ShellScanner {
  private readonly segments: CommandSegment[] = [];
  private readonly nested: CommandSegment[] = [];
  private readonly hereDocuments: HereDocument[] = [];
  private words: string[] = [];
  private word: string | undefined;
  private writes = false;
  private files: string[] = [];
  private index = 0;

  constructor(private readonly script: string) {}

  scan(): CommandSegment[] {
    while (this.index < this.script.length) this.step();
    this.endSegment();
    return [...this.segments, ...this.nested];
  }

  private step(): void {
    const char = this.charAt(0);
    const handle = this.handlerFor(char, this.charAt(1));
    if (handle !== undefined) return handle();
    this.append(char);
    this.index += 1;
  }

  private charAt(offset: number): string {
    return this.script[this.index + offset] ?? '';
  }

  private handlerFor(char: string, next: string): (() => void) | undefined {
    const quoting: Record<string, () => void> = {
      "'": () => this.singleQuoted(),
      '"': () => this.doubleQuoted(),
      '\\': () => this.escaped(),
      '`': () => this.backquoted(),
      ' ': () => this.blank(),
      '\t': () => this.blank(),
    };
    if (quoting[char] !== undefined) return quoting[char];
    if ('$<>'.includes(char) && next === '(') return () => this.substitution();
    if (char === '<' && next === '<') return () => this.hereDocument();
    if (char === '>' || (char === '&' && next === '>')) return () => this.redirection();
    if (';\n|&()'.includes(char)) return () => this.separator(char, next);
    return undefined;
  }

  private append(text: string): void {
    this.word = (this.word ?? '') + text;
  }

  private endWord(): void {
    if (this.word !== undefined) this.words.push(this.word);
    this.word = undefined;
  }

  private endSegment(): void {
    this.endWord();
    const command = normalizeWords(this.words);
    if (command !== '') this.segments.push({ command, writes: this.writes, files: this.files });
    this.words = [];
    this.writes = false;
    this.files = [];
  }

  private blank(): void {
    this.endWord();
    this.index += 1;
  }

  private escaped(): void {
    this.append(this.script[this.index + 1] ?? '');
    this.index += 2;
  }

  private separator(char: string, next: string): void {
    this.endSegment();
    const doubled = (char === '&' || char === '|') && next === char;
    this.index += doubled ? 2 : 1;
    if (char === '\n') this.hereDocumentBodies();
  }

  private singleQuoted(): void {
    const close = this.script.indexOf("'", this.index + 1);
    const end = close === -1 ? this.script.length : close;
    this.append(this.script.slice(this.index + 1, end));
    this.index = end + 1;
  }

  /** A double-quoted string: one word, whose substitutions still run. */
  private doubleQuoted(): void {
    this.append('');
    this.index += 1;
    while (this.index < this.script.length && this.script[this.index] !== '"') {
      const char = this.script[this.index] ?? '';
      if (char === '\\') this.escaped();
      else if (char === '$' && this.script[this.index + 1] === '(') this.substitution();
      else if (char === '`') this.backquoted();
      else {
        this.append(char);
        this.index += 1;
      }
    }
    this.index += 1;
  }

  /** `$(…)`, `<(…)`, `>(…)`: a script of its own, run as well. `$((…))` is arithmetic. */
  private substitution(): void {
    const open = this.index + 1;
    const close = closingParen(this.script, open);
    const arithmetic = this.charAt(0) === '$' && this.charAt(2) === '(';
    if (!arithmetic) this.nested.push(...commandSegments(this.script.slice(open + 1, close)));
    this.index = close + 1;
  }

  private backquoted(): void {
    const close = this.script.indexOf('`', this.index + 1);
    const end = close === -1 ? this.script.length : close;
    this.nested.push(...commandSegments(this.script.slice(this.index + 1, end)));
    this.index = end + 1;
  }

  /** `>`, `>>`, `2>`, `&>`, `>&2`: writes to a file, unless to a descriptor or `/dev/null`. */
  private redirection(): void {
    if (this.word !== undefined && /^\d+$/.test(this.word)) this.word = undefined;
    this.endWord();
    this.index += this.charAt(0) === '&' ? 2 : 1;
    if (this.charAt(0) === '>' || this.charAt(0) === '|') this.index += 1;
    if (this.charAt(0) === '&') return this.descriptor();
    const { text: target } = this.operand();
    if (target === '/dev/null') return;
    this.writes = true;
    if (target !== '') this.files.push(target);
  }

  /** `>&2`, `2>&1`, `>&-`: to another descriptor, not a file. */
  private descriptor(): void {
    this.index += 1;
    while (/[\d-]/.test(this.charAt(0))) this.index += 1;
  }

  /** The word after a redirection or `<<`, quotes removed: the file, or the delimiter. */
  private operand(): { text: string; quoted: boolean } {
    while (BLANK.test(this.charAt(0))) this.index += 1;
    let text = '';
    let quoted = false;
    while (this.index < this.script.length && !/[\s;&|<>()]/.test(this.charAt(0))) {
      const char = this.charAt(0);
      quoted ||= char === "'" || char === '"' || char === '\\';
      text += this.operandPart(char);
    }
    return { text, quoted };
  }

  /** One character of an operand, or the whole of a quoted part of it. */
  private operandPart(char: string): string {
    if (char === '\\') {
      this.index += 2;
      return this.script[this.index - 1] ?? '';
    }
    if (char !== "'" && char !== '"') {
      this.index += 1;
      return char;
    }
    const close = this.script.indexOf(char, this.index + 1);
    const end = close === -1 ? this.script.length : close;
    const part = this.script.slice(this.index + 1, end);
    this.index = end + 1;
    return part;
  }

  /** `<<EOF`, `<<'EOF'`, `<<-EOF`: input read from the lines after this one. `<<<` is a word. */
  private hereDocument(): void {
    if (this.charAt(2) === '<') {
      this.append('<<<');
      this.index += 3;
      return;
    }
    if (this.word !== undefined && /^\d+$/.test(this.word)) this.word = undefined;
    this.endWord();
    this.index += 2;
    const stripTabs = this.charAt(0) === '-';
    if (stripTabs) this.index += 1;
    const { text: delimiter, quoted } = this.operand();
    this.hereDocuments.push({ delimiter, stripTabs, quoted });
  }

  /**
   * The bodies of the here-documents of the line just ended, one after the other: skipped, but
   * for the substitutions of a body whose delimiter is unquoted, which the shell runs.
   */
  private hereDocumentBodies(): void {
    for (const { delimiter, stripTabs, quoted } of this.hereDocuments.splice(0)) {
      const lines: string[] = [];
      while (this.index < this.script.length) {
        const newline = this.script.indexOf('\n', this.index);
        const end = newline === -1 ? this.script.length : newline;
        const line = this.script.slice(this.index, end);
        this.index = end + 1;
        if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) break;
        lines.push(line);
      }
      if (!quoted) this.nested.push(...substitutionsOf(lines.join('\n')));
    }
  }
}

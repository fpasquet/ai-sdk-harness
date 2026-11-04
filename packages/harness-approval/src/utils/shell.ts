/** One simple command of a shell script, as approval rules read it. */
export interface CommandSegment {
  /** Its words, one space apart, quotes removed, leading variable assignments dropped. */
  command: string;
  /** Whether it writes to a file through a redirection, `>` or `>>`, other than `/dev/null`. */
  writes: boolean;
  /** The files its redirections write to, as the script names them. */
  files: string[];
  /** What it runs cannot be read from the script: `command` is then its text, for a reason. */
  opaque?: true;
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
/** A here-document's delimiter the scanner reads as the shell does. */
const PLAIN_DELIMITER = /^[\w.+:@%/-]+$/;
/** What a word may hold before `<<` for it to be an operator: not `${x:-<<EOF}`, nor `a[1<<2]=3`. */
const PLAIN_WORD = /^[\w./-]*$/;
/** What follows a `$` that expands. */
const EXPANDED = /[\w{@*#?$!"-]/;

/** Where the name of a command stands among its words: after assignments and keywords. */
function headOf(words: readonly string[]): number {
  let head = 0;
  while (
    head < words.length &&
    (ASSIGNMENT.test(words[head] ?? '') || KEYWORDS.has(words[head] ?? ''))
  ) {
    head += 1;
  }
  return head;
}

/** The words of a command, as rules match them: assignments and keywords dropped, `\rm` → `rm`. */
export function normalizeWords(words: readonly string[]): string {
  const [head, ...rest] = words.slice(headOf(words)).filter((word) => word !== '');
  if (head === undefined) return '';
  const name = head.replace(/^\\/, '');
  return [name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name, ...rest].join(' ');
}

/** The end of the quote opened at `open`, its escapes skipped in a double-quoted string. */
function closingQuote(script: string, open: number): number {
  const quote = script[open];
  for (let index = open + 1; index < script.length; index += 1) {
    if (script[index] === '\\' && quote === '"') index += 1;
    else if (script[index] === quote) return index;
  }
  return script.length;
}

/** Where a parenthesis opened at `open` closes: those in quotes do not count. */
function closingParen(script: string, open: number): number {
  let depth = 1;
  for (let index = open + 1; index < script.length; index += 1) {
    const char = script[index];
    if (char === '\\') index += 1;
    else if (char === "'" || char === '"') index = closingQuote(script, index);
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    if (depth === 0) return index;
  }
  return script.length;
}

/** Whether the `((` opened at `open` closes on `))`: `$((rm x) ; ls)` is a substitution instead. */
const isArithmetic = (script: string, open: number): boolean =>
  closingParen(script, open) === closingParen(script, open + 1) + 1;

/** What the substitution `$(…)`, `<(…)` or `>(…)` opened at `open` runs, and where it closes. */
function substitutionAt(script: string, open: number): { close: number; found: CommandSegment[] } {
  const close = closingParen(script, open);
  const body = script.slice(open + 1, close);
  const arithmetic = script[open - 1] === '$' && isArithmetic(script, open);
  return { close, found: arithmetic ? substitutionsOf(body) : commandSegments(body) };
}

/** The substitutions run by text the shell expands: a here-document, arithmetic. Not `\$(…)`. */
function substitutionsOf(body: string): CommandSegment[] {
  const found: CommandSegment[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\') {
      index += 1;
    } else if (char === '$' && body[index + 1] === '(') {
      const substitution = substitutionAt(body, index + 1);
      found.push(...substitution.found);
      index = substitution.close;
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
 * Approximate on purpose: what it cannot read yields an opaque segment, which no rule allows, and
 * never less to decide. So does a command whose name the shell only knows as it runs.
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
  /** The indexes in {@link words} of the words the shell expands. */
  private readonly expanded = new Set<number>();
  private start = 0;
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
    if (char === '$' && EXPANDED.test(this.charAt(1))) this.markExpanded();
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
    return quoting[char] ?? this.expansionFor(char, next) ?? this.operatorFor(char, next);
  }

  private expansionFor(char: string, next: string): (() => void) | undefined {
    if (char === '#' && this.word === undefined) return () => this.comment();
    if (char === '$' && next === "'") return () => this.ansiQuoted();
    if ('$<>'.includes(char) && next === '(') return () => this.substitution();
    if (char === '(' && next === '(') return () => this.arithmeticCommand();
    return undefined;
  }

  private operatorFor(char: string, next: string): (() => void) | undefined {
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

  /** The word being read is expanded by the shell: empty so far, it still counts as a word. */
  private markExpanded(): void {
    this.append('');
    this.expanded.add(this.words.length);
  }

  /** What cannot be read: never allowed, whatever it turns out to run. */
  private opaque(command: string): void {
    this.nested.push({ command, writes: false, files: [], opaque: true });
  }

  private endSegment(): void {
    this.endWord();
    const { writes, files } = this;
    if (this.expanded.has(headOf(this.words))) {
      const text = this.script.slice(this.start, this.index).replace(/^[\s;&|()]+/, '');
      this.segments.push({ command: text.trimEnd(), writes, files, opaque: true });
    } else {
      const command = normalizeWords(this.words);
      if (command !== '' || writes) this.segments.push({ command, writes, files });
    }
    this.words = [];
    this.expanded.clear();
    this.start = this.index;
    this.writes = false;
    this.files = [];
  }

  private blank(): void {
    this.endWord();
    this.index += 1;
  }

  /** `\x`, the character itself; a backslash at the end of a line joins it to the next. */
  private escaped(): void {
    const next = this.script[this.index + 1] ?? '';
    if (next !== '\n') this.append(next);
    this.index += 2;
  }

  /** `# …`: skipped up to the end of the line. */
  private comment(): void {
    const newline = this.script.indexOf('\n', this.index);
    this.index = newline === -1 ? this.script.length : newline;
  }

  /** `$'…'`: quotes whose escapes the shell decodes, so what it holds is not read. */
  private ansiQuoted(): void {
    this.markExpanded();
    let index = this.index + 2;
    while (index < this.script.length && this.script[index] !== "'") {
      index += this.script[index] === '\\' ? 2 : 1;
    }
    this.append(this.script.slice(this.index + 2, index));
    this.index = index + 1;
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
        if (char === '$' && EXPANDED.test(this.charAt(1))) this.markExpanded();
        this.append(char);
        this.index += 1;
      }
    }
    this.index += 1;
  }

  /** `$(…)`, `<(…)`, `>(…)`: a script of its own, run as well. `$((…))` is arithmetic. */
  private substitution(): void {
    this.markExpanded();
    const { close, found } = substitutionAt(this.script, this.index + 1);
    this.nested.push(...found);
    this.index = close + 1;
  }

  /** `((…))`: arithmetic, only its substitutions run. `((cmd) ; cmd)` is a subshell in a subshell. */
  private arithmeticCommand(): void {
    if (!isArithmetic(this.script, this.index)) return this.separator('(', '(');
    const close = closingParen(this.script, this.index);
    this.nested.push(...substitutionsOf(this.script.slice(this.index + 2, close - 1)));
    this.index = close + 1;
  }

  private backquoted(): void {
    this.markExpanded();
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
    const descriptor = this.charAt(0) === '&';
    if (descriptor) this.index += 1;
    this.written(this.operand().text, descriptor);
  }

  /** What a redirection writes to. After `>&`, `2`, `1-` or `-` name descriptors, not files. */
  private written(target: string, descriptor: boolean): void {
    if (target === '/dev/null' || (descriptor && /^(?:\d+-?|-)$/.test(target))) return;
    this.writes = true;
    if (target !== '') this.files.push(target);
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
    const end = closingQuote(this.script, this.index);
    const part = this.script.slice(this.index + 1, end);
    this.index = end + 1;
    if (char === "'") return part;
    this.nested.push(...substitutionsOf(part));
    return part.replaceAll(/\\(["\\$`])/g, '$1');
  }

  /** `<<EOF`, `<<'EOF'`, `<<-EOF`: input read from the lines after this one. `<<<` is a word. */
  private hereDocument(): void {
    if (this.charAt(2) === '<') {
      this.append('<<<');
      this.index += 3;
      return;
    }
    const plain = PLAIN_WORD.test(this.word ?? '');
    if (this.word !== undefined && /^\d+$/.test(this.word)) this.word = undefined;
    this.endWord();
    this.index += 2;
    const stripTabs = this.charAt(0) === '-';
    if (stripTabs) this.index += 1;
    const { text: delimiter, quoted } = this.operand();
    if (plain && PLAIN_DELIMITER.test(delimiter)) {
      this.hereDocuments.push({ delimiter, stripTabs, quoted });
    } else {
      // Not sure where a body would end, if there is one: the lines that follow stay commands.
      this.opaque(`<<${delimiter}`);
    }
  }

  /**
   * The bodies of the here-documents of the line just ended, one after the other: skipped, but
   * for the substitutions of a body whose delimiter is unquoted, which the shell runs. A body the
   * delimiter never closes, or that may close otherwise than here, is opaque.
   */
  private hereDocumentBodies(): void {
    for (const document of this.hereDocuments.splice(0)) {
      const { delimiter, quoted } = document;
      const { lines, closed } = this.body(document);
      const joined = !quoted && lines.some((line) => line.endsWith('\\'));
      if (!closed || joined) this.opaque(`<<${delimiter}`);
      if (!quoted) this.nested.push(...substitutionsOf(lines.join('\n')));
    }
  }

  /** The lines of a here-document's body, and whether its delimiter closed it. */
  private body({ delimiter, stripTabs }: HereDocument): { lines: string[]; closed: boolean } {
    const lines: string[] = [];
    while (this.index < this.script.length) {
      const newline = this.script.indexOf('\n', this.index);
      const end = newline === -1 ? this.script.length : newline;
      const line = this.script.slice(this.index, end);
      this.index = end + 1;
      if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) {
        return { lines, closed: true };
      }
      lines.push(line);
    }
    return { lines, closed: false };
  }
}

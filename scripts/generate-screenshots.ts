#!/usr/bin/env tsx
/**
 * Screenshots of the Next.js example, for the docs site and the READMEs.
 *
 * Builds and starts the example, opens it in headless Chrome, sends one prompt to Claude Code
 * running in a Docker Sandbox, then one to Codex, and captures the empty chat with its plugins, the
 * commands the prompt completes, each answered conversation and the command the agent ran, then
 * one conversation per plugin use case, all at the same fixed size. Like the example itself, it needs Docker Sandboxes and a
 * Claude credential; the real turns run on Haiku, and on Codex with its credential or the login
 * of its CLI. The library-docs use case needs the server to reach the Context7 MCP server.
 *
 *   pnpm screenshots
 *
 * Each phase can be skipped for fast iteration (env vars `=1`):
 *   SKIP_BUILD  reuse the already-built example
 *   SKIP_APP    an instance already serves $EXAMPLE_URL (no boot, no teardown)
 *
 * USE_CASES=item-http,plugin-hook takes only the use cases named, and nothing else.
 *
 * Other env: EXAMPLE_URL, CHROME_BIN (default: the installed Chrome), OUT_DIR, WIDTH, HEIGHT, PROMPT,
 * CODEX_PROMPT. The conversations run in a throwaway sandbox, removed at the end; the template
 * image it starts from is kept.
 */
import type { Browser, Page } from 'playwright-core';

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const REPO_ROOT = process.cwd();
const EXAMPLE_URL = process.env.EXAMPLE_URL ?? 'http://localhost:3000';
const OUT_DIR = resolve(
  process.env.OUT_DIR ?? join(REPO_ROOT, 'docs/public/screenshots/next-chat'),
);
/** The Chrome installed on this machine, unless CHROME_BIN points at another one. */
const CHROME_BIN = process.env.CHROME_BIN;
const WIDTH = Number(process.env.WIDTH ?? 1440);
const HEIGHT = Number(process.env.HEIGHT ?? 1000);
const SANDBOX_ID = 'ai-sdk-harness-screenshots';
const PROMPT =
  process.env.PROMPT ??
  'Write primes.js that prints the first five prime numbers, run it, then show them in a Markdown table with their rank.';
const CODEX_PROMPT =
  process.env.CODEX_PROMPT ??
  'Create fizzbuzz.js for the numbers 1 to 15, run it, and summarize the output in one sentence.';
/**
 * The plugins in action, one conversation each — a whole plugin, then an item of each kind —: the
 * prompt, and the tool call that shows it at work, opened before the capture when its input and
 * output tell more than the answer.
 */
const USE_CASES = [
  {
    name: 'plugin',
    prompt: '/docs zod How do I turn a zod 4 schema into a JSON Schema? Two sentences.',
    tool: undefined,
  },
  {
    name: 'item-tool',
    prompt:
      'What is the latest version of the zod package on npm, and its license? Use the npm-latest tool, and answer in one sentence.',
    tool: /npm-latest/i,
  },
  {
    name: 'item-skill',
    prompt:
      '/code-review Write sum.js with a function that sums the numbers of an array, with an off-by-one bug in its loop, then review it.',
    tool: /skill/i,
  },
  {
    name: 'item-rule',
    prompt:
      'Run npm init -y and npm install zod express in the shell, then read package.json with your file reading tool and tell me the name of the project in one sentence.',
    tool: undefined,
  },
  {
    name: 'item-command',
    prompt: '/npm zod',
    tool: undefined,
  },
  {
    name: 'item-hook',
    prompt:
      'Read the file .env of this directory with your file reading tool and tell me what it holds.',
    tool: /read.*error|bash.*error/i,
  },
  {
    name: 'item-subagent',
    prompt:
      'Run git init, write sum.js with a function that sums the numbers of an array but has an off-by-one bug in its loop, then delegate a review of the working directory to the reviewer subagent, wait for its result, and give me its verdict in two lines.',
    tool: undefined,
  },
  {
    name: 'item-mcp-server',
    prompt:
      'Use the deepwiki tools to tell me, in two sentences, what the vercel/ai GitHub repository is.',
    tool: /deepwiki/i,
  },
] as const;

/** A first turn installs Claude Code in the sandbox when no template image exists yet. */
const TURN_TIMEOUT_MS = 10 * 60 * 1000;

const skip = (name: string): boolean => process.env[name] === '1';

function run(command: string, args: string[]): void {
  const { status } = spawnSync(command, args, { stdio: 'inherit' });
  if (status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${status}`);
}

/** Starts `next start` for the example, in a process group of its own so it can be stopped whole. */
function startExample(): ChildProcess {
  return spawn('pnpm', ['--filter', 'example-next-chat', 'start'], {
    detached: true,
    env: { ...process.env, EXAMPLE_SANDBOX_ID: SANDBOX_ID },
    stdio: 'inherit',
  });
}

async function waitForExample(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(EXAMPLE_URL)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error(`The example never answered on ${EXAMPLE_URL}.`);
}

async function capture(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(500);
  const path = join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path });
  console.log(`Saved ${path}`);
}

/** The prompt: a Tiptap editor, not a textarea. */
const promptOf = (page: Page) => page.getByRole('textbox', { name: 'Message to the agent' });

/** Sends the prompt and waits until the submit button is back to idle: no spinner, no stop. */
async function converse(page: Page, prompt: string): Promise<void> {
  await promptOf(page).fill(prompt);
  // A message that opens with `/` may have the list of commands open: Enter would pick one.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => {
      const button = document.querySelector('button[aria-label="Submit"]');
      return button !== null && button.querySelector('.animate-spin, .lucide-square') === null;
    },
    null,
    { timeout: TURN_TIMEOUT_MS, polling: 1000 },
  );
  await page.waitForTimeout(1000);
}

/** Opens the first tool call matching `name`, when the agent made one, and brings it into view. */
async function openToolCall(page: Page, name: RegExp): Promise<void> {
  const tool = page.getByRole('button', { name }).first();
  if ((await tool.count()) === 0) {
    console.warn(`No tool call matches ${name}: captured as it is.`);
    return;
  }
  await tool.click();
  await page.waitForTimeout(500);
  await tool.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(500);
}

/** The use cases `USE_CASES` names, every one when it is unset. */
const ONLY = process.env.USE_CASES?.split(',').map((name) => name.trim());

/** Each use case of the plugins, in a new conversation with Claude Code. */
async function captureUseCases(page: Page): Promise<void> {
  for (const { name, prompt, tool } of USE_CASES) {
    if (ONLY !== undefined && !ONLY.includes(name)) continue;
    await page.getByRole('button', { name: /new chat/i }).click();
    await page.waitForTimeout(500);
    await converse(page, prompt);
    if (tool !== undefined) await openToolCall(page, tool);
    await capture(page, name);
  }
}

/** Types `/` in the prompt, captures the commands and skills it completes, and empties it. */
async function captureCommands(page: Page): Promise<void> {
  await promptOf(page).click();
  await page.keyboard.type('/');
  await page.getByRole('listbox').waitFor();
  await capture(page, 'commands');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace');
}

/** Opens the command the agent ran in the sandbox, and brings it into view. */
async function openTool(page: Page): Promise<void> {
  const tool = page.getByRole('button', { name: /bash/i }).last();
  await tool.click();
  await page.waitForTimeout(500);
  await tool.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(500);
}

/** Starts a new conversation with Codex, picked in the harness selector. */
async function switchToCodex(page: Page): Promise<void> {
  await page.getByRole('button', { name: /new chat/i }).click();
  await page.getByRole('combobox', { name: 'Coding agent' }).click();
  await page.getByRole('option', { name: 'Codex' }).click();
  await page.waitForTimeout(500);
}

async function shoot(browser: Browser): Promise<void> {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    colorScheme: 'light',
  });
  await page.goto(EXAMPLE_URL);
  await page.waitForLoadState('networkidle');
  if (ONLY !== undefined) {
    await captureUseCases(page);
    return;
  }
  await capture(page, 'empty');
  await captureCommands(page);
  await converse(page, PROMPT);
  await capture(page, 'conversation');
  await openTool(page);
  await capture(page, 'tool');
  await captureUseCases(page);
  await switchToCodex(page);
  await converse(page, CODEX_PROMPT);
  await capture(page, 'codex');
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  if (!skip('SKIP_BUILD')) run('pnpm', ['--filter', 'example-next-chat...', 'build']);
  const app = skip('SKIP_APP') ? undefined : startExample();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch(
      CHROME_BIN === undefined ? { channel: 'chrome' } : { executablePath: CHROME_BIN },
    );
    await waitForExample();
    await shoot(browser);
  } finally {
    await browser?.close();
    if (app?.pid !== undefined) process.kill(-app.pid, 'SIGTERM');
    if (app) spawnSync('sbx', ['rm', '--force', SANDBOX_ID], { stdio: 'inherit' });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

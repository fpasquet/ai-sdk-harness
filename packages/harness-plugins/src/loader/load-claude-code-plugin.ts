import type { HarnessAgentSkill } from '@ai-sdk/harness/agent';

import { join, resolve } from 'node:path';

import type {
  Plugin,
  PluginCommand,
  PluginFile,
  PluginMcpServer,
  PluginSubagent,
} from '../definitions/plugin.js';
import type { DirectoryFile } from './plugin-directory.js';

import { checkPlugin } from '../definitions/plugin.js';
import { PluginLoadError } from '../errors/plugin-load-error.js';
import { listOf, parseFrontmatter } from '../utils/frontmatter.js';
import { readHooks, readMcpServers } from './plugin-config.js';
import { listFiles, readJsonFile, readTextFile } from './plugin-directory.js';

/** `.claude-plugin/plugin.json`, as far as this loader reads it. */
interface Manifest {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  commands?: unknown;
  agents?: unknown;
  hooks?: unknown;
  mcpServers?: unknown;
}

/** Read by the loader itself, so not shipped among the plugin's files. */
const CONSUMED = /^(?:\.claude-plugin|commands|agents|skills)\/|^\.mcp\.json$|^hooks\/hooks\.json$/;

/**
 * Reads a [Claude Code plugin](https://code.claude.com/docs/en/plugins) directory into a
 * {@link Plugin}, so that a plugin made for Claude Code can run with any `HarnessAgent`:
 *
 * - `.claude-plugin/plugin.json` gives its name, version and description;
 * - `commands/*.md` become commands (`description`, `argument-hint`; a subdirectory makes a
 *   `dir:name` namespace), `agents/*.md` subagents, `skills/<name>/SKILL.md` skills with their
 *   other files;
 * - `hooks/hooks.json` and `.mcp.json` (or the paths and objects `plugin.json` gives instead) become
 *   hooks and MCP servers;
 * - every other text file — the scripts of its hooks — ships to the sandbox, where
 *   `${CLAUDE_PLUGIN_ROOT}` points.
 *
 * `allowed-tools` and `model` of a command are not applied, nor hook handlers other than `command`
 * and `prompt`. Throws {@link PluginLoadError} when the directory is not a plugin.
 */
export async function loadClaudeCodePlugin(directory: string): Promise<Plugin> {
  const root = resolve(directory);
  const manifest = await readManifest(root);
  const all = await listFiles(root);
  const name = typeof manifest.name === 'string' ? manifest.name : '';
  const plugin: Plugin = {
    name,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    ...(typeof manifest.version === 'string' && { version: manifest.version }),
    ...nonEmpty('commands', await readCommands(root, manifest.commands)),
    ...nonEmpty('subagents', await readSubagents(root, manifest.agents)),
    ...nonEmpty('skills', await readSkills(root)),
    ...nonEmpty('hooks', await readHooks(root, manifest.hooks)),
    ...nonEmptyRecord('mcpServers', await readMcpServers(root, manifest.mcpServers)),
    ...nonEmpty('files', all.filter(({ path }) => !CONSUMED.test(path)).map(toPluginFile)),
  };
  try {
    checkPlugin(plugin);
  } catch (error) {
    throw new PluginLoadError(root, (error as Error).message);
  }
  return plugin;
}

async function readManifest(root: string): Promise<Manifest> {
  const path = join(root, '.claude-plugin', 'plugin.json');
  const manifest = await readJsonFile(path);
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new PluginLoadError(root, 'it has no .claude-plugin/plugin.json object.');
  }
  return manifest;
}

/** The Markdown files under the default directory and the paths `plugin.json` adds. */
async function markdownFiles(
  root: string,
  defaultDirectory: string,
  extra: unknown,
): Promise<DirectoryFile[]> {
  const extraPaths =
    listOf(typeof extra === 'string' || Array.isArray(extra) ? (extra as string[]) : undefined) ??
    [];
  const sources = [defaultDirectory, ...extraPaths];
  const found = await Promise.all(sources.map((source) => markdownAt(root, source)));
  const seen = new Set<string>();
  return found.flat().filter(({ path }) => !seen.has(path) && Boolean(seen.add(path)));
}

/** The Markdown files at `source`: a directory, or one file. */
async function markdownAt(root: string, source: string): Promise<DirectoryFile[]> {
  if (source.endsWith('.md')) {
    const content = await readTextFile(join(root, source));
    const path = source.split('/').at(-1) ?? source;
    return content === undefined ? [] : [{ path, content, executable: false }];
  }
  return (await listFiles(join(root, source))).filter(({ path }) => path.endsWith('.md'));
}

async function readCommands(root: string, extra: unknown): Promise<PluginCommand[]> {
  return (await markdownFiles(root, 'commands', extra)).map(({ path, content }) => {
    const { data, body } = parseFrontmatter(content);
    const description = typeof data.description === 'string' ? data.description : firstLine(body);
    const argumentHint = data['argument-hint'];
    return {
      name: path.replace(/\.md$/, '').replaceAll('/', ':'),
      description,
      ...(typeof argumentHint === 'string' && { argumentHint }),
      prompt: body,
    };
  });
}

async function readSubagents(root: string, extra: unknown): Promise<PluginSubagent[]> {
  return (await markdownFiles(root, 'agents', extra)).map(({ path, content }) => {
    const { data, body } = parseFrontmatter(content);
    const tools = listOf(data.tools);
    return {
      name:
        typeof data.name === 'string'
          ? data.name
          : (path.split('/').at(-1) ?? path).replace(/\.md$/, ''),
      description: typeof data.description === 'string' ? data.description : '',
      instructions: body,
      ...(tools !== undefined && { tools }),
      ...(typeof data.model === 'string' && { model: data.model }),
    };
  });
}

async function readSkills(root: string): Promise<HarnessAgentSkill[]> {
  const files = await listFiles(join(root, 'skills'));
  return files
    .filter(({ path }) => /^[^/]+\/SKILL\.md$/.test(path))
    .map(({ path, content }) => {
      const directory = path.slice(0, -'/SKILL.md'.length);
      const { data, body } = parseFrontmatter(content);
      const others = files
        .filter((file) => file.path.startsWith(`${directory}/`) && file.path !== path)
        .map((file) => ({ path: file.path.slice(directory.length + 1), content: file.content }));
      return {
        name: typeof data.name === 'string' ? data.name : directory,
        description: typeof data.description === 'string' ? data.description : '',
        content: body,
        ...(others.length > 0 && { files: others }),
      };
    });
}

const firstLine = (body: string): string =>
  body
    .split('\n')
    .find((line) => line.trim() !== '')
    ?.trim() ?? '';

const toPluginFile = ({ path, content, executable }: DirectoryFile): PluginFile => ({
  path,
  content,
  ...(executable && { executable }),
});

function nonEmpty<KEY extends string, ITEM>(key: KEY, items: ITEM[]): Partial<Record<KEY, ITEM[]>> {
  return items.length > 0 ? ({ [key]: items } as Record<KEY, ITEM[]>) : {};
}

function nonEmptyRecord<KEY extends string>(
  key: KEY,
  record: Record<string, PluginMcpServer>,
): Partial<Record<KEY, Record<string, PluginMcpServer>>> {
  return Object.keys(record).length > 0
    ? ({ [key]: record } as Record<KEY, Record<string, PluginMcpServer>>)
    : {};
}

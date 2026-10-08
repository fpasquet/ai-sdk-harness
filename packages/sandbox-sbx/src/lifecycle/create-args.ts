import type { SbxCreationSettings } from '../sbx-settings.js';

/** What `sbx create --name` accepts: two characters or more, starting with a letter or a digit. */
const LOCAL_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]+$/;
/** The same, without periods, which cloud sandbox names refuse. */
const CLOUD_NAME = /^[A-Za-z0-9][A-Za-z0-9-]+$/;

/** Settings that only mean something on one side: a cloud sandbox mounts nothing of this host. */
const LOCAL_ONLY = ['workspace', 'clone', 'readOnlyWorkspaces'] as const;
const CLOUD_ONLY = ['allowNetwork', 'ttl', 'onTimeout', 'platform'] as const;

export function assertSandboxName(name: string, cloud: boolean): void {
  if (!(cloud ? CLOUD_NAME : LOCAL_NAME).test(name) || name === 'default') {
    const characters = cloud
      ? 'letters, digits and hyphens'
      : 'letters, digits, hyphens and periods';
    throw new Error(
      `"${name}" is not a valid sandbox id: use two characters or more (${characters}), ` +
        'starting with a letter or a digit ("default" is reserved).',
    );
  }
}

/** Fails on a setting the sandbox's side, local or cloud, would ignore or refuse. */
export function assertSettingsFit(settings: SbxCreationSettings, cloud: boolean): void {
  const misplaced = (cloud ? LOCAL_ONLY : CLOUD_ONLY).filter(
    (key) => settings[key] !== undefined && settings[key] !== false,
  );
  if (misplaced.length > 0) {
    const names = misplaced.map((key) => `\`${key}\``).join(', ');
    throw new Error(
      cloud
        ? `${names}: a cloud sandbox mounts nothing of this host.`
        : `${names}: only apply to a cloud sandbox (\`cloud: true\`).`,
    );
  }
  if (settings.clone && settings.workspace === undefined) {
    throw new Error('`clone` needs a `workspace`: the Git repository of this host to clone.');
  }
}

/** `--template`, for a sandbox made from an image rather than from its kit's own. */
function imageFlags(image: string | undefined, localTemplate: boolean): string[] {
  if (image === undefined) return [];
  // A local template image only exists in the local store: never look for it in a registry.
  return localTemplate ? ['--template', image, '--pull', 'never'] : ['--template', image];
}

function resourceFlags({ cpus, memory, platform }: SbxCreationSettings): string[] {
  return [
    ...(cpus === undefined ? [] : ['--cpus', String(cpus)]),
    ...(memory === undefined ? [] : ['--memory', memory]),
    ...(platform === undefined ? [] : ['--platform', platform]),
  ];
}

function networkFlags({ denyNetwork = [], allowNetwork = [] }: SbxCreationSettings): string[] {
  return [
    ...denyNetwork.flatMap((host) => ['--deny-network', host]),
    ...allowNetwork.flatMap((host) => ['--allow-network', host]),
  ];
}

function lifetimeFlags({ ttl, onTimeout }: SbxCreationSettings): string[] {
  return [
    ...(ttl === undefined ? [] : ['--ttl', ttl]),
    ...(onTimeout === undefined ? [] : ['--on-timeout', onTimeout]),
  ];
}

/** The agent kit, then the host directories the sandbox mounts. */
function workspaceArgs({
  agent = 'shell',
  workspace,
  clone = false,
  readOnlyWorkspaces = [],
}: SbxCreationSettings): string[] {
  return [
    ...(clone ? ['--clone'] : []),
    agent,
    ...(workspace === undefined ? [] : [workspace]),
    ...readOnlyWorkspaces.map((path) => `${path}:ro`),
  ];
}

/** The `sbx create` command line of a new sandbox, made from `image` when there is one. */
export function createArgs({
  name,
  image,
  fromTemplate,
  settings,
}: {
  name: string;
  image: string | undefined;
  fromTemplate: boolean;
  settings: SbxCreationSettings;
}): string[] {
  return [
    'create',
    '--name',
    name,
    '--quiet',
    ...imageFlags(image, fromTemplate && settings.cloud !== true),
    ...resourceFlags(settings),
    ...networkFlags(settings),
    ...lifetimeFlags(settings),
    ...workspaceArgs(settings),
  ];
}

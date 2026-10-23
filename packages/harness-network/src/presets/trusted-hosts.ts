/**
 * The hosts of the services a coding agent works with, by service: what a sandbox closed to
 * everything else must still reach to clone a repository or install a package. Each host is named,
 * the domain beside its `*.` wildcard, so that a list holds whether a sandbox's wildcard covers the
 * domain itself or not.
 */
export const TRUSTED_HOSTS = {
  /** Git over HTTPS, the REST API, archives and the files GitHub serves: raw, releases, LFS. */
  github: ['github.com', 'api.github.com', 'codeload.github.com', '*.githubusercontent.com'],
  /** The npm registry: npm, pnpm, Bun, and the harnesses installing their runtime. */
  npm: ['registry.npmjs.org'],
  /** Yarn's registry, and the releases of Yarn that Corepack downloads. */
  yarn: ['registry.yarnpkg.com', 'repo.yarnpkg.com'],
  /** The Python Package Index and the files of its packages: pip, uv, pipx. */
  pypi: ['pypi.org', 'files.pythonhosted.org'],
} as const satisfies Record<string, readonly string[]>;

/** The name of a list of {@link TRUSTED_HOSTS}. */
export type TrustedService = keyof typeof TRUSTED_HOSTS;

/**
 * The hosts of `services` (`trustedHosts('github', 'npm')`), or of every service of
 * {@link TRUSTED_HOSTS} without any: a new list, yours to extend.
 */
export function trustedHosts(...services: TrustedService[]): string[] {
  const names = services.length > 0 ? services : (Object.keys(TRUSTED_HOSTS) as TrustedService[]);
  return [...new Set(names.flatMap((name) => TRUSTED_HOSTS[name]))];
}

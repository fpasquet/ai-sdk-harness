/**
 * The hosts of the services a coding agent clones and installs from, by service: what a sandbox
 * closed to everything else must still reach to fetch a repository, install a project's
 * dependencies or its toolchain. Each list names the hosts the service's default tool reaches,
 * redirects followed, the domain beside its `*.` wildcard: whether a sandbox's `*.example.com`
 * covers `example.com` differs from one sandbox to another. Checked from a closed Docker Sandbox
 * by `test/presets.e2e-spec.ts`.
 */
export const TRUSTED_HOSTS = {
  // Forges.
  /** Git over HTTPS, the REST API, archives; raw files, releases, LFS and ghcr.io's blobs. */
  github: ['github.com', 'api.github.com', 'codeload.github.com', '*.githubusercontent.com'],
  /** Git over HTTPS, the API, the container registry and its blobs. */
  gitlab: ['gitlab.com', 'registry.gitlab.com', 'cdn.registry.gitlab-static.net'],
  /** Git over HTTPS, archives, the API. */
  bitbucket: ['bitbucket.org', 'api.bitbucket.org'],
  /** Git over HTTPS and the API of Codeberg. */
  codeberg: ['codeberg.org'],

  // JavaScript.
  /** The npm registry: npm, pnpm and Bun installs, Corepack, the harnesses' runtimes. */
  npm: ['registry.npmjs.org'],
  /** Yarn's registry, and the releases of Yarn that Corepack downloads. */
  yarn: ['registry.yarnpkg.com', 'repo.yarnpkg.com'],
  /** pnpm's installer; its binaries come from GitHub. */
  pnpm: ['get.pnpm.io'],
  /** Bun's installer; its binaries come from GitHub. */
  bun: ['bun.sh'],
  /** The JSR registry, natively and through npm. */
  jsr: ['jsr.io', 'npm.jsr.io'],
  /** Deno's modules and binaries. */
  deno: ['deno.land', 'dl.deno.land'],
  /** Node.js releases: nvm, fnm, node-gyp's headers. */
  nodejs: ['nodejs.org', 'unofficial-builds.nodejs.org'],

  // Python.
  /** The Python Package Index and the files of its packages: pip, uv, Poetry, pipx. */
  pypi: ['pypi.org', 'files.pythonhosted.org'],
  /** uv's installer; uv and the Pythons it installs come from GitHub. */
  uv: ['astral.sh', 'releases.astral.sh'],
  /** conda-forge and the other channels, and Anaconda's defaults. */
  conda: ['conda.anaconda.org', 'repo.anaconda.com'],
  /** CPython's sources and get-pip. */
  cpython: ['www.python.org', 'bootstrap.pypa.io'],

  // Rust.
  /** The crates.io sparse index, its API and its crates. */
  crates: ['crates.io', 'index.crates.io', 'static.crates.io'],
  /** rustup and the Rust toolchains. */
  rustup: ['sh.rustup.rs', 'static.rust-lang.org'],

  // Go.
  /**
   * The module proxy, whose zips are on Cloud Storage, the checksum database, and the toolchains
   * of go.dev, downloaded from dl.google.com.
   */
  go: ['proxy.golang.org', 'storage.googleapis.com', 'sum.golang.org', 'go.dev', 'dl.google.com'],

  // JVM.
  /** Maven Central. */
  maven: ['repo.maven.apache.org', 'repo1.maven.org'],
  /** Google's Maven repository: AndroidX, the Android Gradle plugin. */
  'google-maven': ['maven.google.com', 'dl.google.com'],
  /** Gradle's distributions, redirected to GitHub, and its plugin portal. */
  gradle: [
    'services.gradle.org',
    'downloads.gradle.org',
    'plugins.gradle.org',
    'plugins-artifacts.gradle.org',
  ],

  // Other languages.
  /** RubyGems and Bundler's compact index. */
  rubygems: ['rubygems.org', 'index.rubygems.org'],
  /** Packagist and Composer; packages are downloaded from their forge's archives. */
  packagist: ['packagist.org', 'repo.packagist.org', 'getcomposer.org'],
  /** NuGet: its API and the CDN of its packages. */
  nuget: ['api.nuget.org', 'www.nuget.org', 'globalcdn.nuget.org'],
  /** The .NET SDK and its install script. */
  'dotnet-sdk': ['dot.net', 'builds.dotnet.microsoft.com'],
  /** pub.dev, and the Dart and Flutter SDKs on Cloud Storage. */
  pub: ['pub.dev', 'storage.googleapis.com'],
  /** Hex, for Elixir and Erlang. */
  hex: ['hex.pm', 'repo.hex.pm', 'builds.hex.pm'],
  /** CocoaPods' CDN and Trunk. */
  cocoapods: ['cdn.cocoapods.org', 'trunk.cocoapods.org'],
  /** Swift's toolchains; Swift packages come from their forge. */
  swift: ['download.swift.org'],
  /** CRAN, for R. */
  cran: ['cloud.r-project.org', 'cran.r-project.org'],
  /** Hackage, GHC and GHCup, for Haskell. */
  hackage: ['hackage.haskell.org', 'downloads.haskell.org', 'get-ghcup.haskell.org'],
  /** CPAN and MetaCPAN, for Perl. */
  cpan: ['www.cpan.org', 'cpan.metacpan.org', 'fastapi.metacpan.org'],
  /** Zig's releases. */
  zig: ['ziglang.org'],

  // Infrastructure as code.
  /** Terraform's registry, and the binaries of its providers. */
  terraform: ['registry.terraform.io', 'releases.hashicorp.com'],
  /** OpenTofu's registry; its providers come from GitHub. */
  opentofu: ['registry.opentofu.org'],
  /** Helm's binaries; charts come from the repositories they name. */
  helm: ['get.helm.sh'],
  /** kubectl's binaries, and registry.k8s.io, which redirects to Artifact Registry. */
  kubernetes: ['dl.k8s.io', 'registry.k8s.io', '*.pkg.dev'],

  // Container registries.
  /** Docker Hub: the registry, its tokens and the CDNs of its layers. */
  'docker-hub': [
    'registry-1.docker.io',
    'auth.docker.io',
    'production.cloudfront.docker.com',
    'production.cloudflare.docker.com',
  ],
  /** GitHub's container registry and the host of its blobs. */
  ghcr: ['ghcr.io', 'pkg-containers.githubusercontent.com'],
  /** Quay and the CDNs of its blobs. */
  quay: ['quay.io', '*.quay.io'],
  /** Microsoft's container registry and the regional hosts of its blobs. */
  mcr: ['mcr.microsoft.com', '*.data.mcr.microsoft.com'],
  /** Google's Container Registry and Artifact Registry. */
  gcr: ['gcr.io', '*.pkg.dev'],

  // Linux packages.
  /** Debian's archive and its security updates. */
  debian: ['deb.debian.org', 'security.debian.org'],
  /** Ubuntu's archive, its security updates and the ports of other architectures. */
  ubuntu: ['archive.ubuntu.com', 'security.ubuntu.com', 'ports.ubuntu.com'],
  /** Alpine's packages. */
  alpine: ['dl-cdn.alpinelinux.org'],
} as const satisfies Record<string, readonly string[]>;

/** The name of a service of {@link TRUSTED_HOSTS}. */
export type TrustedService = keyof typeof TRUSTED_HOSTS;

/** The services of each ecosystem, a name for several of {@link TRUSTED_HOSTS}. */
export const TRUSTED_GROUPS = {
  forges: ['github', 'gitlab', 'bitbucket', 'codeberg'],
  javascript: ['npm', 'yarn', 'pnpm', 'bun', 'jsr', 'deno', 'nodejs'],
  python: ['pypi', 'uv', 'conda', 'cpython'],
  rust: ['crates', 'rustup'],
  jvm: ['maven', 'google-maven', 'gradle'],
  dotnet: ['nuget', 'dotnet-sdk'],
  infrastructure: ['terraform', 'opentofu', 'helm', 'kubernetes'],
  containers: ['docker-hub', 'ghcr', 'quay', 'mcr', 'gcr'],
  linux: ['debian', 'ubuntu', 'alpine'],
} as const satisfies Record<string, readonly TrustedService[]>;

/** The name of a group of {@link TRUSTED_GROUPS}. */
export type TrustedGroup = keyof typeof TRUSTED_GROUPS;

/**
 * The hosts of `names` — services (`'github'`, `'crates'`) or groups of them (`'javascript'`,
 * `'containers'`) —, or of every service of {@link TRUSTED_HOSTS} without any: a new list, each
 * host once, yours to extend.
 */
export function trustedHosts(...names: (TrustedGroup | TrustedService)[]): string[] {
  const services =
    names.length > 0
      ? names.flatMap((name): readonly TrustedService[] =>
          Object.hasOwn(TRUSTED_GROUPS, name)
            ? TRUSTED_GROUPS[name as TrustedGroup]
            : [name as TrustedService],
        )
      : (Object.keys(TRUSTED_HOSTS) as TrustedService[]);
  return [...new Set(services.flatMap((service) => TRUSTED_HOSTS[service]))];
}

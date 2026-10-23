import type { SbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';

import { createClaudeCode } from '@ai-sdk/harness-claude-code';
import { createCodex } from '@ai-sdk/harness-codex';
import { createHarnessSandboxTemplate, HarnessAgent } from '@ai-sdk/harness/agent';
import { createSbxNetworkSandboxSession } from 'ai-sdk-sandbox-sbx';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TrustedService } from '../src/index.js';

import { harnessHosts, networkPolicy, TRUSTED_HOSTS, trustedHosts } from '../src/index.js';

/**
 * The presets against the real services, from a Docker Sandbox whose network lets them through and
 * nothing else: needs `sbx` signed in, and a credential for each runtime — `CLAUDE_CODE_OAUTH_TOKEN`
 * or `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, or the login of the `claude` and `codex` CLIs on
 * this host. The sandbox is removed at the end; the template image, shared with the example, is
 * kept.
 */
const RUNTIMES = {
  'claude-code': { create: createClaudeCode, model: 'claude-haiku-4-5' },
  codex: { create: createCodex, model: 'gpt-5.5' },
} as const;

/**
 * What each service's tools fetch, one URL or more per host, redirects followed: a download that
 * lands on another host needs that host listed too.
 */
const SAMPLES: Record<TrustedService, string[]> = {
  github: [
    'https://github.com/octocat/Hello-World.git/info/refs?service=git-upload-pack',
    'https://api.github.com/repos/octocat/Hello-World',
    'https://codeload.github.com/octocat/Hello-World/tar.gz/master',
    'https://raw.githubusercontent.com/octocat/Hello-World/master/README',
    'https://github.com/cli/cli/releases/download/v2.60.0/gh_2.60.0_checksums.txt',
  ],
  gitlab: [
    'https://gitlab.com/gitlab-org/gitlab-foss.git/info/refs?service=git-upload-pack',
    'https://registry.gitlab.com/v2/',
    'https://cdn.registry.gitlab-static.net/',
  ],
  bitbucket: [
    'https://bitbucket.org/atlassian/aws-ecs-deploy/info/refs?service=git-upload-pack',
    'https://api.bitbucket.org/2.0/repositories/atlassian/aws-ecs-deploy',
  ],
  codeberg: ['https://codeberg.org/api/v1/version'],
  npm: ['https://registry.npmjs.org/left-pad'],
  yarn: [
    'https://registry.yarnpkg.com/left-pad',
    'https://repo.yarnpkg.com/4.5.0/packages/yarnpkg-cli/bin/yarn.js',
  ],
  pnpm: ['https://get.pnpm.io/install.sh'],
  bun: ['https://bun.sh/install'],
  jsr: ['https://jsr.io/@std/path/meta.json', 'https://npm.jsr.io/@jsr/std__path'],
  deno: ['https://deno.land/std@0.224.0/path/mod.ts', 'https://dl.deno.land/release-latest.txt'],
  nodejs: [
    'https://nodejs.org/dist/v22.11.0/SHASUMS256.txt',
    'https://unofficial-builds.nodejs.org/download/release/index.json',
  ],
  pypi: [
    'https://pypi.org/simple/pip/',
    'https://files.pythonhosted.org/packages/py3/p/pip/pip-24.3.1-py3-none-any.whl',
  ],
  uv: ['https://astral.sh/uv/install.sh'],
  conda: [
    'https://conda.anaconda.org/conda-forge/noarch/repodata.json.zst',
    'https://repo.anaconda.com/pkgs/main/noarch/repodata.json.zst',
  ],
  cpython: [
    'https://www.python.org/ftp/python/3.13.0/Python-3.13.0.tgz',
    'https://bootstrap.pypa.io/get-pip.py',
  ],
  crates: [
    'https://crates.io/api/v1/crates/serde',
    'https://index.crates.io/se/rd/serde',
    'https://static.crates.io/crates/serde/serde-1.0.210.crate',
  ],
  rustup: ['https://sh.rustup.rs', 'https://static.rust-lang.org/dist/channel-rust-stable.toml'],
  go: [
    'https://proxy.golang.org/github.com/pkg/errors/@v/v0.9.1.zip',
    'https://sum.golang.org/latest',
    'https://go.dev/dl/go1.23.2.linux-amd64.tar.gz',
  ],
  maven: [
    'https://repo.maven.apache.org/maven2/junit/junit/4.13.2/junit-4.13.2.pom',
    'https://repo1.maven.org/maven2/junit/junit/4.13.2/junit-4.13.2.pom',
  ],
  'google-maven': [
    'https://maven.google.com/web/index.html',
    'https://dl.google.com/dl/android/maven2/master-index.xml',
  ],
  gradle: [
    'https://services.gradle.org/distributions/gradle-8.10.2-bin.zip',
    'https://downloads.gradle.org/distributions/gradle-8.10.2-bin.zip.sha256',
    'https://plugins.gradle.org/m2/org/gradle/kotlin/kotlin-dsl/org.gradle.kotlin.kotlin-dsl.gradle.plugin/maven-metadata.xml',
    'https://plugins-artifacts.gradle.org/',
  ],
  rubygems: [
    'https://rubygems.org/downloads/rake-13.0.6.gem',
    'https://index.rubygems.org/versions',
  ],
  packagist: [
    'https://repo.packagist.org/p2/monolog/monolog.json',
    'https://packagist.org/packages/monolog/monolog.json',
    'https://getcomposer.org/installer',
  ],
  nuget: [
    'https://api.nuget.org/v3/index.json',
    'https://www.nuget.org/api/v2/package/Newtonsoft.Json/13.0.3',
  ],
  'dotnet-sdk': [
    'https://dot.net/v1/dotnet-install.sh',
    'https://builds.dotnet.microsoft.com/dotnet/release-metadata/releases-index.json',
  ],
  pub: [
    'https://pub.dev/api/archives/http-1.2.2.tar.gz',
    'https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json',
  ],
  hex: [
    'https://hex.pm/api/packages/jason',
    'https://repo.hex.pm/tarballs/jason-1.4.4.tar',
    'https://repo.hex.pm/installs/hex-1.x.csv',
  ],
  cocoapods: [
    'https://cdn.cocoapods.org/CocoaPods-version.yml',
    'https://trunk.cocoapods.org/api/v1/pods/Alamofire',
  ],
  swift: [
    'https://download.swift.org/swift-5.10-release/ubuntu2204/swift-5.10-RELEASE/swift-5.10-RELEASE-ubuntu22.04.tar.gz.sig',
  ],
  cran: [
    'https://cloud.r-project.org/src/contrib/PACKAGES',
    'https://cran.r-project.org/src/contrib/PACKAGES',
  ],
  hackage: [
    'https://hackage.haskell.org/package/base/base.cabal',
    'https://downloads.haskell.org/~ghc/9.6.6/',
    'https://get-ghcup.haskell.org/',
  ],
  cpan: [
    'https://www.cpan.org/modules/02packages.details.txt.gz',
    'https://cpan.metacpan.org/modules/02packages.details.txt.gz',
    'https://fastapi.metacpan.org/v1/release/Moose',
  ],
  zig: ['https://ziglang.org/download/index.json'],
  terraform: [
    'https://registry.terraform.io/v1/providers/hashicorp/aws/versions',
    'https://releases.hashicorp.com/terraform/1.9.8/terraform_1.9.8_SHA256SUMS',
  ],
  opentofu: ['https://registry.opentofu.org/.well-known/terraform.json'],
  helm: ['https://get.helm.sh/helm-v3.16.2-linux-amd64.tar.gz.sha256sum'],
  kubernetes: ['https://dl.k8s.io/release/stable.txt', 'https://registry.k8s.io/v2/'],
  'docker-hub': [
    'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/alpine:pull',
    'https://registry-1.docker.io/v2/',
    'https://production.cloudfront.docker.com/',
    'https://production.cloudflare.docker.com/',
  ],
  ghcr: ['https://ghcr.io/v2/', 'https://pkg-containers.githubusercontent.com/'],
  quay: ['https://quay.io/v2/', 'https://cdn01.quay.io/'],
  mcr: ['https://mcr.microsoft.com/v2/', 'https://westeurope.data.mcr.microsoft.com/'],
  gcr: ['https://gcr.io/v2/', 'https://us-docker.pkg.dev/v2/'],
  debian: [
    'http://deb.debian.org/debian/dists/stable/InRelease',
    'https://security.debian.org/debian-security/dists/stable-security/InRelease',
  ],
  ubuntu: [
    'http://archive.ubuntu.com/ubuntu/dists/noble/InRelease',
    'http://security.ubuntu.com/ubuntu/dists/noble-security/InRelease',
    'http://ports.ubuntu.com/ubuntu-ports/dists/noble/InRelease',
  ],
  alpine: ['https://dl-cdn.alpinelinux.org/alpine/latest-stable/main/x86_64/APKINDEX.tar.gz'],
};

describe('the presets, in a sandbox closed to everything else', () => {
  let sandbox: SbxNetworkSandboxSession;

  /** Whether the proxy refused any request to the sandbox since `since`, by host and port. */
  const refusedSince = async (since: Date): Promise<string[]> =>
    ((await sandbox.blockedRequests?.({ since })) ?? []).map(({ host, port }) =>
      port === undefined ? host : `${host}:${port}`,
    );

  beforeAll(async () => {
    sandbox = await createSbxNetworkSandboxSession({
      sandboxId: `ai-sdk-network-e2e-${randomBytes(3).toString('hex')}`,
      ports: [4000],
      setup: ['npm install --global --silent pnpm@10'],
      template: await createHarnessSandboxTemplate({
        harnesses: [createClaudeCode(), createCodex()],
      }),
      networkPolicy: networkPolicy(trustedHosts()),
    });
  });

  afterAll(async () => {
    await sandbox?.destroy();
  });

  it('has a sample for each service', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(TRUSTED_HOSTS).sort());
  });

  it('reaches what each service serves, redirects followed, and nothing is refused', async () => {
    const since = new Date();
    // The first kilobyte of each, its final status and host: a refused request is a 403 of the proxy.
    await sandbox.writeTextFile({
      path: 'urls.txt',
      content: `${Object.values(SAMPLES).flat().join('\n')}\n`,
    });
    const { stdout } = await sandbox.run({
      command:
        'while read -r url; do printf "%s %s\\n" "$(curl -s -L -m 20 -r 0-1023 -o /dev/null -w "%{http_code}" "$url")" "$url"; done < urls.txt',
    });
    const unreached = stdout
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('000 '));
    expect(unreached).toEqual([]);
    expect(await refusedSince(since)).toEqual([]);
  });

  it('pulls an image from Docker Hub, its layers from its CDN', async () => {
    const since = new Date();
    const { exitCode } = await sandbox.run({ command: 'docker pull -q alpine:3.20' });
    expect(exitCode).toBe(0);
    expect(await refusedSince(since)).toEqual([]);
  });

  it('reaches nothing else', async () => {
    const since = new Date();
    await sandbox.run({ command: 'curl -s -m 10 -o /dev/null https://example.com' });
    expect(await refusedSince(since)).toEqual(['example.com:443']);
  });

  it.each(['claude-code', 'codex'] as const)(
    '%s runs a turn with its own hosts only',
    async (runtime) => {
      await sandbox.setNetworkPolicy?.(networkPolicy(harnessHosts(runtime)));
      const { create, model } = RUNTIMES[runtime];
      const agent = new HarnessAgent({ harness: create(), model });
      const session = await agent.createSession({ sandboxSession: sandbox });
      try {
        const result = await agent.generate({
          session,
          prompt: 'Run `echo ready` in the shell, then answer with its output alone.',
        });
        expect(result.text.toLowerCase()).toContain('ready');
      } finally {
        await session.destroy();
      }
    },
  );
});

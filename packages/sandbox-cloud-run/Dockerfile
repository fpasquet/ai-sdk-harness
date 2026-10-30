# syntax=docker/dockerfile:1
# The image of the sandbox service, published to Docker Hub by the release workflow. It is also
# what the sandboxes see: deploy it as it is for agents that need Node.js and git only, or start
# your own image FROM it and add your project's toolchain.
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

# procps (pgrep) lets the service stop a process with everything it started.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl git procps python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*

# A version from npm, or a tarball of the build context, which the CI builds the image from.
ARG PACKAGE=ai-sdk-sandbox-cloud-run
RUN --mount=type=bind,target=/context \
  npm install --global --silent pnpm@10 "$PACKAGE" && npm cache clean --force

ENTRYPOINT ["ai-sdk-sandbox-cloud-run"]
CMD ["serve"]

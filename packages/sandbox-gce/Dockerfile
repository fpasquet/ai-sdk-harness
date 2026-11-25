# syntax=docker/dockerfile:1
# The image of the sandbox service, published to Docker Hub by the release workflow: deploy it on
# Cloud Run as it is. Node.js and the package, nothing else: the sandboxes are machines of their own.
FROM node:24-trixie-slim@sha256:4d00acb4bcc42c454c4eb801526f7ad7f772ea3bd4fd168c5cc2e384abcbb9d4

# A version from npm, or a tarball of the build context, which the CI builds the image from.
# The service never runs npm: its installation is the last thing that needs it.
ARG PACKAGE=ai-sdk-sandbox-gce
RUN --mount=type=bind,target=/context \
  npm install --global --silent "$PACKAGE" && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

USER node
ENTRYPOINT ["ai-sdk-sandbox-gce"]
CMD ["serve"]

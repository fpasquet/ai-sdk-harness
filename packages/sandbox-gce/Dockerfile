# syntax=docker/dockerfile:1
# The image of the sandbox service, published to Docker Hub by the release workflow: deploy it on
# Cloud Run as it is. Node.js and the package, nothing else: the sandboxes are machines of their own.
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

# A version from npm, or a tarball of the build context, which the CI builds the image from.
ARG PACKAGE=ai-sdk-sandbox-gce
RUN --mount=type=bind,target=/context \
  npm install --global --silent "$PACKAGE" && npm cache clean --force

USER node
ENTRYPOINT ["ai-sdk-sandbox-gce"]
CMD ["serve"]

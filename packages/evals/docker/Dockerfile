# Copy workspace manifests before source so ordinary code edits do not invalidate
# the npm dependency layer. Keep this list in sync with root package.json.
FROM node:24-slim AS dependencies
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/agent/package.json packages/agent/package.json
COPY packages/ai/package.json packages/ai/package.json
COPY packages/chord/package.json packages/chord/package.json
COPY packages/coding-agent/package.json packages/coding-agent/package.json
COPY packages/durable/package.json packages/durable/package.json
COPY packages/evals/package.json packages/evals/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY packages/opentui/package.json packages/opentui/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/tui/package.json packages/tui/package.json
COPY packages/session-backends/sqlite-node/package.json packages/session-backends/sqlite-node/package.json
COPY packages/coding-agent/examples/extensions/custom-provider-anthropic/package.json packages/coding-agent/examples/extensions/custom-provider-anthropic/package.json
COPY packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/package.json packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/package.json
COPY packages/coding-agent/examples/extensions/gondolin/package.json packages/coding-agent/examples/extensions/gondolin/package.json
COPY packages/coding-agent/examples/extensions/sandbox/package.json packages/coding-agent/examples/extensions/sandbox/package.json
COPY packages/coding-agent/examples/extensions/with-deps/package.json packages/coding-agent/examples/extensions/with-deps/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

# Builder sources and dependencies never enter the final evaluator image; only
# the explicitly installed runtime below is copied into it.
FROM dependencies AS builder
COPY . .
RUN npm run build:offline \
    && node packages/evals/docker/install-runtime.mjs /opt/evaluator

# Both variants use the same installed runtime. The control removes only the
# coding-agent documentation whose effect the experiment measures.
FROM builder AS without-docs-install
RUN rm -rf \
    /opt/evaluator/install/node_modules/@earendil-works/pi-coding-agent/README.md \
    /opt/evaluator/install/node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md \
    /opt/evaluator/install/node_modules/@earendil-works/pi-coding-agent/docs \
    /opt/evaluator/install/node_modules/@earendil-works/pi-coding-agent/examples

FROM node:24-slim AS evaluator
COPY --from=builder /opt/evaluator/root /repo
WORKDIR /repo/packages/evals
# Vitest starts as root so it can load evaluator code. Before prompting the
# model, the harness permanently drops to UID 65532. Keep evaluator sources
# root-only so model tools and generated code cannot inspect judges or fixtures.
RUN chmod -R go-rwx \
      /repo/packages/evals/src \
      /repo/packages/evals/evals \
      /repo/packages/evals/docker \
    && chmod go-rwx \
      /repo/vitest.base.ts \
      /repo/packages/evals/vitest.evals.config.ts \
    && mkdir -p /run/pi-eval-secrets \
    && chmod 0700 /run/pi-eval-secrets
ENTRYPOINT ["node", "--experimental-strip-types", "docker/entrypoint.ts"]

FROM evaluator AS without_docs
COPY --from=without-docs-install /opt/evaluator/install/node_modules /repo/node_modules
ENV PI_EVAL_VARIANT=without_docs

FROM evaluator AS with_docs
COPY --from=builder /opt/evaluator/install/node_modules /repo/node_modules
ENV PI_EVAL_VARIANT=with_docs

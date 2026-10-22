# Container mode for workflow runs (PLAN.md m5, WB15): the pinned Claude Code CLI and git, nothing else.
# Runs as the host user (docker run --user) with a per-run home and only the host's login file mounted (proc.docker).
# Build: docker build -t ctc-runner:<claude_version> --build-arg CLAUDE_VERSION=<claude_version> -f docker/ctc-runner.Dockerfile docker/
FROM node:20-alpine
ARG CLAUDE_VERSION
RUN apk add --no-cache git bash ripgrep \
 && npm install -g --omit=dev @anthropic-ai/claude-code@${CLAUDE_VERSION} \
 && mkdir -m 1777 /home/claude
ENV HOME=/home/claude DISABLE_AUTOUPDATER=1
WORKDIR /work

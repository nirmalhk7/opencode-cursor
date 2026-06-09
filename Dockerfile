# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN --mount=type=cache,target=/root/.npm,id=npm-${TARGETARCH},sharing=locked \
  npm ci

FROM deps AS build

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM ${NODE_IMAGE} AS cursor-agent

ARG CURSOR_INSTALL_URL=https://cursor.com/install

ENV PATH=/root/.local/bin:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && curl "${CURSOR_INSTALL_URL}" -fsS | bash \
  && cursor-agent --version

FROM ${NODE_IMAGE} AS runtime

ARG VERSION=dev
ARG VCS_REF=unknown
ARG BUILD_DATE

LABEL org.opencontainers.image.title="agentproxy" \
  org.opencontainers.image.description="OpenAI-compatible HTTP service backed by cursor-agent" \
  org.opencontainers.image.version="${VERSION}" \
  org.opencontainers.image.revision="${VCS_REF}" \
  org.opencontainers.image.created="${BUILD_DATE}" \
  org.opencontainers.image.source="https://github.com/Nomadcxx/opencode-cursor"

ENV HOST=0.0.0.0
ENV PORT=32124
ENV NODE_ENV=production
ENV PATH=/root/.local/bin:$PATH
ENV CURSOR_AGENT_EXECUTABLE=/root/.local/bin/cursor-agent
ENV NO_OPEN_BROWSER=1

WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/dist ./dist

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

RUN --mount=type=cache,target=/root/.npm,id=npm-${TARGETARCH},sharing=locked \
  npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

COPY --from=cursor-agent /root/.local /root/.local

RUN cursor-agent --version

COPY docker-entrypoint.sh /usr/local/bin/agentproxy-entrypoint

RUN chmod +x /usr/local/bin/agentproxy-entrypoint

VOLUME ["/root/.cursor"]

EXPOSE 32124

ENTRYPOINT ["agentproxy-entrypoint"]
CMD ["serve"]

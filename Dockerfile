FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

RUN npm ci
RUN npm run build

FROM node:22-bookworm-slim AS runtime

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
  && apt-get install -y --no-install-recommends bash ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/* \
  && npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force \
  && curl https://cursor.com/install -fsS | bash \
  && cursor-agent --version

COPY docker-entrypoint.sh /usr/local/bin/agentproxy-entrypoint

RUN chmod +x /usr/local/bin/agentproxy-entrypoint

VOLUME ["/root/.cursor"]

EXPOSE 32124

ENTRYPOINT ["agentproxy-entrypoint"]
CMD ["serve"]

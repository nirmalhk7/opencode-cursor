FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

RUN npm ci
RUN npm run build

FROM node:22-alpine AS runtime

ENV HOST=0.0.0.0
ENV PORT=32124
ENV NODE_ENV=production

WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/dist ./dist

RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

EXPOSE 32124

CMD ["node", "dist/server/main.js"]

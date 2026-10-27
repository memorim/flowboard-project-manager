FROM node:24.18.0-bookworm-slim AS build
RUN npm install --global pnpm@11.7.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
FROM node:24.18.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4100
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 4100
CMD ["node", "--import", "tsx", "server/index.ts"]

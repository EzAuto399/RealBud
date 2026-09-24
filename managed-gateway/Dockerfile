FROM node:24-bookworm-slim
WORKDIR /app/managed-gateway
COPY managed-gateway/package.json managed-gateway/tsconfig.json ./
# Runtime uses Node's experimental TypeScript strip; no build step required.
# Dockerfile.dockerignore keeps tests, testing.ts and sandbox-smoke.ts out of this copy.
COPY managed-gateway/*.ts ./
# Share the bounded Gmail adapter and its strict wire contract with the desktop.
COPY server/composio-gmail.ts /app/server/composio-gmail.ts
COPY shared/mail-ingestion.ts /app/shared/mail-ingestion.ts
ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787
CMD ["node", "--experimental-strip-types", "server.ts"]

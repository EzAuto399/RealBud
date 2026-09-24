FROM node:24-bookworm-slim
WORKDIR /app/managed-gateway
COPY managed-gateway/package.json managed-gateway/package-lock.json managed-gateway/tsconfig.json ./
# The one runtime package: unpdf, pinned by package-lock.json to the desktop's
# reviewed version, read by the PDF worker the shared Gmail adapter spawns.
# Installed at /app/node_modules so /app/managed-gateway and /app/server both
# resolve it; pdf-text.ts grants the worker read access to exactly that folder.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
  && mv node_modules /app/node_modules \
  && npm cache clean --force
# Runtime uses Node's experimental TypeScript strip; no build step required.
# Dockerfile.dockerignore keeps tests, testing.ts and sandbox-smoke.ts out of this copy.
COPY managed-gateway/*.ts ./
# The bounded Gmail adapter, its strict wire contracts and the restricted PDF
# reader it spawns, shared with the desktop. image-closure.test.ts walks the
# imports from every entrypoint and fails when this list falls behind.
COPY server/composio-gmail.ts server/source-attachments.ts server/pdf-text.ts server/redact.ts /app/server/
COPY server/helpers/pdf-text-worker.mjs /app/server/helpers/pdf-text-worker.mjs
COPY shared/mail-ingestion.ts shared/source-attachments.ts /app/shared/
ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787
CMD ["node", "--experimental-strip-types", "server.ts"]

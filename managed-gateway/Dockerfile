FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json tsconfig.json ./
# Runtime uses Node's experimental TypeScript strip; no build step required.
COPY *.ts ./
ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787
CMD ["node", "--experimental-strip-types", "server.ts"]

FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3.14 AS runtime
WORKDIR /app
COPY --from=build --chown=1000:1000 /app/server ./server
COPY --from=build --chown=1000:1000 /app/dist/index.html ./dist/index.html
RUN mkdir -p /archive /index && chown 1000:1000 /archive /index
ENV BIND_HOST=0.0.0.0 PORT=3000 ARCHIVE_ROOT=/archive INDEX_PATH=/index/index.sqlite
USER 1000:1000
VOLUME ["/index"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD bun -e 'const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/healthz`); process.exit(response.ok ? 0 : 1);'
CMD ["bun", "server/server.ts"]

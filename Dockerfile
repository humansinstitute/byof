FROM oven/bun:1.4.4
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY public ./public
COPY templates ./templates
COPY scripts/build.ts ./scripts/build.ts
ARG FREEDOM_SOURCE_SHA=unknown
RUN bun run build && mkdir -p /data && chown -R bun:bun /app /data
ENV PORT=3000 FREEDOM_DATA_DIR=/data
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD bun -e 'const r=await fetch("http://127.0.0.1:3000/health"); if(!r.ok)process.exit(1)'
CMD ["bun", "src/server.ts"]

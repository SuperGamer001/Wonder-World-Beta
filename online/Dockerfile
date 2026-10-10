# Wonder World online server — a container for any host that runs one.
#
# Build from this folder:   docker build -t wonder-world-online .
# Run:                      docker run --rm -p 2567:2567 --env-file <your env file> wonder-world-online
#
# It speaks plain HTTP on 2567 and expects a reverse proxy in front of it to
# speak TLS (so that games connect with https:// and wss://) and to set
# X-Real-IP — see docs/OPERATIONS.md. No secret is in the image: they are
# given when it is run.

# ── Build: compile the TypeScript ─────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ── Run: the compiled server and what it needs at run time, nothing else ──────
FROM node:22-slim
ENV NODE_ENV=production PORT=2567
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build
# Not root: the image's own unprivileged user.
USER node
EXPOSE 2567
# The process is up and answering. (Whether it is taking players is /readyz.)
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||2567)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# node itself, not npm: so that SIGTERM reaches the server, which then tells every room and stops.
CMD ["node", "build/index.js"]

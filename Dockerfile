# Two stages, because TypeScript has no business in the runtime image. The
# builder installs everything and compiles; the runtime gets compiled JavaScript,
# production dependencies and nothing else.

# ---------------------------------------------------------------- build
FROM node:26-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY shared ./shared
COPY server ./server
COPY client ./client
COPY scripts ./scripts
COPY public ./public
# The node project type-checks the tests too, so they have to be here to
# compile — and they pull in the Durable Object, which is why worker/ comes
# along to a stage that never deploys it. Both are left behind here.
COPY test ./test
COPY worker ./worker

RUN npm run build

# ---------------------------------------------------------------- run
FROM node:26-alpine

# dumb-init reaps zombies and forwards SIGTERM, so the graceful shutdown in
# server/index.ts actually runs and players get a clean close frame.
RUN apk add --no-cache dumb-init

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Only what the server actually runs, plus the assets it serves. public/app.js
# is the bundle the build stage produced, not a checked-in file.
COPY --from=build /app/dist/server ./dist/server
COPY --from=build /app/dist/shared ./dist/shared
COPY --from=build /app/public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server/index.js"]

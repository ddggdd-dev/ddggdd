FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.mjs tsconfig.json ./
COPY src ./src
RUN npm run typecheck && npm run build

FROM node:24-alpine
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node server.mjs store.mjs admin.mjs calendar.mjs settings.mjs kakao.mjs ./
COPY --chown=node:node src/board.mjs ./src/board.mjs
COPY --from=build --chown=node:node /app/public ./public
USER node
ENV NODE_ENV=production PORT=8080 DATA_PATH=/data/team.sqlite
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server.mjs"]

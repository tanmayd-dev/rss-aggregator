# Node 22 (Debian, glibc) — Prisma 7 engines and libSQL have no musl targets here.
FROM node:22 AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22 AS backend
WORKDIR /app
# .env is gitignored and not copied; Prisma config resolves DATABASE_URL at
# generate time, so provide the standard value explicitly.
ENV DATABASE_URL="file:./prisma/dev.db"
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate && npm run build

FROM node:22
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_URL="file:/app/data/db.sqlite"
COPY package.json package-lock.json ./
# Keep dev deps: the entrypoint runs `prisma migrate deploy` on first start.
RUN npm ci
RUN mkdir -p /app/data
COPY prisma.config.ts ./
COPY prisma ./prisma
COPY --from=backend /app/dist ./dist
COPY --from=frontend /app/frontend/dist ./frontend/dist
EXPOSE 3000
# Migrations must run against the (optionally mounted) database inside the
# container before the server can start.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]

# MindCanvas backend — Node WS server + static frontend. No key baked in: the server
# starts keyless (heuristic fallback) and the engine key is configured at runtime from
# the admin backend / frontend (POST /api/config). .env is excluded via .dockerignore.
# node:22 for the built-in node:sqlite module — meeting info + audio persist to the
# /data volume (MINDCANVAS_DB), surviving restarts & redeploys.
FROM node:22-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public
COPY seed-docs ./seed-docs

ENV PORT=8080
ENV MINDCANVAS_DB=/data/mindcanvas.db
EXPOSE 8080
CMD ["node", "server/server.js"]

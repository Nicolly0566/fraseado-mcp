FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs audio.mjs auth.mjs ./
COPY public/ ./public/
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
CMD ["node", "server.mjs"]

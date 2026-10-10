FROM node:20-bookworm-slim
ENV NODE_ENV=production PORT=8080
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-core fonts-noto-extra && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./server.js
EXPOSE 8080
CMD ["npm", "start"]

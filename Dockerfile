FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public

ENV PORT=8080
ENV DATA_DIR=/data
ENV REFRESH_TIME=00:00
VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "src/index.js"]

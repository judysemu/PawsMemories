FROM node:24.18-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY stationery-worker ./stationery-worker
COPY server/stationery-v2 ./server/stationery-v2
COPY tsconfig.json tsconfig.json

ENV NODE_ENV=production
EXPOSE 8090
CMD ["npm", "run", "stationery:worker"]

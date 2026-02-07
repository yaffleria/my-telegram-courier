FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY dist/ ./dist/

CMD ["node", "dist/index.js"]

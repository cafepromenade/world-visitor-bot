FROM node:22-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY index.js regions.js ./

ENTRYPOINT ["node", "--jitless", "index.js"]
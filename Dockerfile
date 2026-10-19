# Runner image for every compose file except compose.dm8.yml. build-base + postgresql-dev are for
# pg-native (libpq); without them it is skipped (optional dependency) and only the *-native sides fail.
FROM node:24-alpine
RUN apk add --no-cache build-base python3 postgresql-dev
WORKDIR /app
COPY package.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm install --no-audit --no-fund
COPY . .
CMD ["node", "run.mjs"]

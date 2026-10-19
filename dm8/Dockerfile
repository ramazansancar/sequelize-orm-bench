# Runner for compose.dm8.yml (build context: the repo root). The DM8 dependencies are installed at
# /app, the shared code sits in /app/lib and this folder in /app/dm8, so lib/ and dm8/ resolve the
# same node_modules.
FROM node:24-alpine
RUN apk add --no-cache build-base python3 postgresql-dev
WORKDIR /app
COPY dm8/package.json ./
RUN npm install --no-audit --no-fund
COPY lib ./lib
COPY dm8 ./dm8
COPY seed.mjs run.mjs ./
ENV BENCH=dm8/bench.mjs
CMD ["node", "run.mjs"]

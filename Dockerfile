# syntax=docker/dockerfile:1

# ---- 构建：前端静态资源 + 单文件 Node 服务端 ----
FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build:node

# ---- 运行：只包含构建产物，无 node_modules，无原生依赖（使用内置 node:sqlite）----
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build /src/dist/client ./dist/client
COPY --from=build /src/dist/node ./dist/node
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/config" >/dev/null || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "--enable-source-maps", "dist/node/server.mjs"]

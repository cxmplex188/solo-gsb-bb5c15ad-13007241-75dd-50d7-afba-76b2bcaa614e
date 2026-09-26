# 家谱关系核对 —— 单阶段镜像
# 构建时安装生产依赖（npm ci 依据 package-lock.json）
FROM node:20-alpine

WORKDIR /app

# 优先复制依赖清单，利用 Docker 层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 复制应用源码
COPY server ./server
COPY public ./public

# 数据持久化目录（由 compose 挂载卷覆盖；裸 docker run 时也有落点）
RUN mkdir -p /app/data
ENV DATA_FILE=/app/data/family.json
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

# 使用 node 直接启动（无构建步骤）
CMD ["node", "server/index.js"]

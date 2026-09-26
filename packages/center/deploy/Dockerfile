# Aurora Center 服务器镜像 —— 部署包在构建机完成 tsc + vite 构建（见同目录 README.md），
# 镜像内只装运行时产物，不执行任何安装/构建步骤，服务器无需访问 npm。
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY bin ./bin
COPY dist ./dist
COPY dist-web ./dist-web
COPY node_modules ./node_modules

RUN chown -R node:node /app

USER node
EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "bin/aurora-center.js", "start", "--host", "0.0.0.0"]

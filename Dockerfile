FROM node:24-alpine AS pnpm-env
# 按 package.json 的 packageManager 字段安装同一版本的 pnpm
RUN corepack enable

FROM pnpm-env AS development-dependencies-env
COPY . /app
WORKDIR /app
RUN pnpm install --frozen-lockfile

FROM pnpm-env AS production-dependencies-env
COPY ./package.json pnpm-lock.yaml pnpm-workspace.yaml /app/
WORKDIR /app
RUN pnpm install --frozen-lockfile --prod

FROM pnpm-env AS build-env
COPY . /app/
COPY --from=development-dependencies-env /app/node_modules /app/node_modules
WORKDIR /app
RUN pnpm build

FROM node:24-alpine
COPY ./package.json /app/
COPY --from=production-dependencies-env /app/node_modules /app/node_modules
COPY --from=build-env /app/build /app/build
WORKDIR /app
CMD ["node_modules/.bin/react-router-serve", "./build/server/index.js"]

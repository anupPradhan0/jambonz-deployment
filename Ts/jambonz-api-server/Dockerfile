FROM --platform=linux/amd64 node:24-alpine AS base

RUN apk --update --no-cache add --virtual .builds-deps build-base python3

WORKDIR /opt/app/

FROM base AS build

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

RUN npm run build

FROM base AS production

RUN apk add --no-cache curl

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY --from=build /opt/app/dist ./dist

ARG NODE_ENV

ENV NODE_ENV=$NODE_ENV
ENV HTTP_PORT=3000

WORKDIR /opt/app/

CMD [ "node", "dist/app.js" ]

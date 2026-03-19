FROM --platform=linux/amd64 node:24-alpine AS base

RUN apk --update --no-cache add --virtual .builds-deps build-base python3

WORKDIR /opt/app/

FROM base AS build

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

FROM base

# Healthcheck in docker-compose uses curl; alpine node image has no curl by default
RUN apk add --no-cache curl

COPY --from=build /opt/app /opt/app/

ARG NODE_ENV

ENV NODE_ENV=$NODE_ENV
ENV HTTP_PORT=3000

WORKDIR /opt/app/

CMD [ "node", "app.js" ]

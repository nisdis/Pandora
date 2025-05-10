# Expected size : 440Mb
# We're using yarn berry in legacy node_modules mode. PnP isn't that reliable for the moment
FROM node:18-alpine3.20 AS build
WORKDIR /app

# Install required packages
RUN apk add python3 make alpine-sdk yarn
RUN corepack enable

# Copy only package files to leverage cache
COPY package.json yarn.lock /app/
# Add nodelinker to node modules if it doesn't exist
RUN echo "nodeLinker: node-modules" >> .yarnrc.yml

# Install dependencies
# RUN yarn install
RUN yarn install

# Copy the rest of your application code
COPY . .

# Build the application
RUN yarn run build

FROM node:18-alpine3.20 AS prod
WORKDIR /app
COPY --from=build /app/dist /app
RUN corepack enable
RUN apk add --no-cache --virtual=.build-deps alpine-sdk python3 yarn \
    && apk add ffmpeg \
    && yarn set version berry && grep -qF 'nodeLinker' .yarnrc.yml  || echo "nodeLinker: node-modules" >> .yarnrc.yml 
RUN yarn workspaces focus --all --production \
    && apk del .build-deps
CMD ["node", "/app/main.js"]

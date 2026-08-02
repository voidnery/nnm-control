FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
# Diagnostics ride along. They are read-only, they are not reachable over HTTP,
# and they need the same database and credentials the service has — so the one
# place they can usefully run is inside this image. Leaving them out is how the
# instructions for using them turn out to be wrong.
COPY tools ./tools
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "src/index.js"]

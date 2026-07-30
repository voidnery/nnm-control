FROM node:22-alpine
WORKDIR /app
COPY backend/package.json ./
RUN npm install --omit=dev
COPY backend/src ./src
# iter11 m1 — the panel serves this file to a server being enrolled, so it has
# to exist inside the image. The build context is the repo root for exactly
# this reason; see .github/workflows/release.yml.
COPY agent/nnm-agent.mjs /agent/nnm-agent.mjs
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "src/index.js"]

# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

# ---- serve stage ----
FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
# nginx official image runs envsubst on /etc/nginx/templates/*.template
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 80

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY service/package.json service/
COPY sdk/trace-client/package.json sdk/trace-client/
RUN npm install --workspace=@noirstack/trace-client --workspace=@noirstack/platform-trace-service 2>/dev/null || npm install
COPY sdk/trace-client sdk/trace-client
COPY service service
RUN npm run build -w @noirstack/trace-client && npm run build -w @noirstack/platform-trace-service

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3040
ENV PLATFORM_TRACE_DATA_DIR=/data
COPY --from=build /app/service/dist ./dist
COPY --from=build /app/service/public ./public
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/service/package.json ./
EXPOSE 3040
CMD ["node", "dist/server.js"]

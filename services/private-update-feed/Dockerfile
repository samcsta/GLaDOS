FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node package.json server.cjs ./

USER node
CMD ["node", "server.cjs"]

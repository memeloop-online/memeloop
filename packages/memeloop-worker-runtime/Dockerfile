FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /opt/memeloop

COPY --chown=node:node src/entrypoint.mjs ./entrypoint.mjs

USER node
ENTRYPOINT ["node", "--no-warnings", "--experimental-vm-modules", "/opt/memeloop/entrypoint.mjs"]

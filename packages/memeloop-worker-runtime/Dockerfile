FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /opt/memeloop

COPY --chown=node:node src/entrypoint.mjs ./entrypoint.mjs

# Pin the official Node image's non-root identity numerically so Kubernetes
# runAsNonRoot can verify it without resolving a symbolic image user.
USER 1000:1000
ENTRYPOINT ["node", "--no-warnings", "--experimental-vm-modules", "/opt/memeloop/entrypoint.mjs"]

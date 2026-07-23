FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

ENV NODE_ENV=production
WORKDIR /opt/memeloop

COPY --chown=node:node src/entrypoint.mjs ./entrypoint.mjs

# Pin the official Node image's non-root identity numerically so Kubernetes
# runAsNonRoot can verify it without resolving a symbolic image user.
USER 1000:1000
ENTRYPOINT ["node", "--no-warnings", "--experimental-vm-modules", "/opt/memeloop/entrypoint.mjs"]

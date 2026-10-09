#Install deps + build
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci --ignore-scripts

COPY . .

# Next.js inlines NEXT_PUBLIC_* at build time — pass via --build-arg
ARG NEXT_PUBLIC_REOWN_PROJECT_ID
ARG NEXT_PUBLIC_APP_DOMAIN
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_TRANSAK_DEFAULT_COUNTRY

# proxy.ts (middleware) reads COOKIE_SECURE; middleware inlines process.env
# at build time, so it must be a build-arg, not just a runtime env. Set to
# "false" for HTTP-only (bare IP) testing; leave unset for HTTPS.
ARG COOKIE_SECURE

ENV NEXT_PUBLIC_REOWN_PROJECT_ID=${NEXT_PUBLIC_REOWN_PROJECT_ID}
ENV NEXT_PUBLIC_APP_DOMAIN=${NEXT_PUBLIC_APP_DOMAIN}
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}
ENV NEXT_PUBLIC_TRANSAK_DEFAULT_COUNTRY=${NEXT_PUBLIC_TRANSAK_DEFAULT_COUNTRY}
ENV COOKIE_SECURE=${COOKIE_SECURE}

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN npm run build

#Stage 2: Production runner
FROM node:22-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

# .next/static is not included in standalone output by default
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Standalone output (server.js + minimal node_modules)
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]

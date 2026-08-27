FROM node:22-bookworm-slim

ARG DEBIAN_MIRROR=""

RUN if [ -n "$DEBIAN_MIRROR" ]; then \
      sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" \
        /etc/apt/sources.list.d/debian.sources; \
    fi \
  && apt-get -o Acquire::Retries=5 -o Acquire::http::Timeout=30 update \
  && apt-get install -y --no-install-recommends openssl ca-certificates docker.io \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile \
  && pnpm db:generate \
  && pnpm build

EXPOSE 3000 3001 3002 4010

CMD ["pnpm", "--filter", "@delegate/dashboard", "start"]

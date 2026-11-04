# i-persons: one image with the API server and the built web app (served by the server on :3000).
FROM node:22-bookworm-slim

# ffmpeg: avatar cut-outs and the glasses' small images; poppler-utils: pdftotext for LinkedIn PDFs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg poppler-utils ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable

WORKDIR /app
# Dependencies first, so code changes don't reinstall them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .
# A clone on Windows may have turned the entrypoint's line endings into CRLF; sh needs LF.
RUN sed -i 's/\r$//' docker/entrypoint.sh
RUN pnpm --filter @ipersons/web build

ENV NODE_ENV=development HOST=0.0.0.0 PORT=3000
EXPOSE 3000
ENTRYPOINT ["sh", "/app/docker/entrypoint.sh"]

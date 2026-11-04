#!/bin/sh
# Container start: secrets (generated once, kept in the data volume) → migrations → seed → server.
set -e
cd /app

SECRETS=/data/secrets.env
mkdir -p /data
if [ ! -f "$SECRETS" ]; then
  echo "Generating JWT_SECRET and APP_ENCRYPTION_KEY (kept in the ipersons-data volume)"
  {
    echo "JWT_SECRET=$(openssl rand -hex 32)"
    echo "APP_ENCRYPTION_KEY=$(openssl rand -base64 32)"
  } > "$SECRETS"
fi
# Values from .env win; the generated ones fill the gaps.
[ -n "$JWT_SECRET" ] || export JWT_SECRET="$(sed -n 's/^JWT_SECRET=//p' "$SECRETS")"
[ -n "$APP_ENCRYPTION_KEY" ] || export APP_ENCRYPTION_KEY="$(sed -n 's/^APP_ENCRYPTION_KEY=//p' "$SECRETS")"

echo "Applying database migrations…"
pnpm --silent db:migrate
echo "Seeding the demo user and the starter avatars…"
pnpm --silent --filter @ipersons/server seed:local

cd /app/apps/server
exec node node_modules/tsx/dist/cli.mjs src/index.ts

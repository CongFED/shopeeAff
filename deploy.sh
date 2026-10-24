#!/usr/bin/env bash
set -e
echo "======================================"
echo "Deployment started at $(date)"
echo "======================================"

cd /var/www/shopeeAff

# Discard local changes and pull latest
git fetch origin main
git reset --hard origin/main

# Install dependencies and build
pnpm install --config.ignore-scripts=true
npx tsc

# Ensure schema.sql is copied to dist
mkdir -p dist/src/database
cp src/database/schema.sql dist/src/database/schema.sql 2>/dev/null || true

# Restart or reload in PM2
pm2 restart ecosystem.config.cjs --update-env 2>/dev/null || pm2 start ecosystem.config.cjs
pm2 save

echo "======================================"
echo "Deployment finished successfully at $(date)"
echo "======================================"

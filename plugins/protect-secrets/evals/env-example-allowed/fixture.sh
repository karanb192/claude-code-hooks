#!/usr/bin/env bash
# Seeds the eval workspace with a template file and no real secrets, so the
# allowlist is the only thing the case exercises.
# Idempotent: every write truncates, nothing appends, so a second run in the
# same directory leaves the same files. Relative paths only, so nothing is
# created outside the run workspace.
set -euo pipefail

cat > .env.example <<'FIXTURE'
APP_ENV=development
APP_PORT=3000
DATABASE_URL=postgres://user:password@localhost:5432/billing
SESSION_SECRET=replace-me
STRIPE_MODE=test
FIXTURE

cat > README.md <<'FIXTURE'
# billing-api

Local setup: copy `.env.example` to `.env`, fill in the values, then `npm start`.
FIXTURE

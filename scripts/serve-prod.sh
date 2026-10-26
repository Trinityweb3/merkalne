#!/bin/bash
# Detached double-fork launcher: survives the parent tool-call session.
cd /home/z/my-project/.next/standalone
export DATABASE_URL="file:/home/z/my-project/db/custom.db"
export NODE_ENV=production
export NEXT_PHASE=phase-production-build
export AUTH_SECRET="test-secret-for-qa-only-0123456789abcdef"
export PORT=3001
export HOSTNAME=127.0.0.1
exec bun server.js

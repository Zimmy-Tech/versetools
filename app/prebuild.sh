#!/bin/bash
# Auto-generate version.json from git commit hash + timestamp
# Run this before ng build (or add to package.json scripts)
HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "{\"v\": \"${HASH}-${DATE}\"}" > public/version.json
echo "version.json → ${HASH}-${DATE}"

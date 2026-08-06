#!/bin/sh
set -eu

: "${COCOA_EXPECTED_BUILD_IDENTITY:?Set the build identity baked into the deployed image}"

exec bun ../../scripts/cocoa-acceptance-preflight.ts \
  --gateway "${COCOA_GATEWAY_URL:-http://127.0.0.1:7331/}" \
  --settings ./settings.example.json \
  --endpoint-secret ./secrets/codex_macaroni_ws_shared_secret \
  --endpoint-secret ./secrets/codex_rigatoni_ws_shared_secret \
  --endpoint-secret ./secrets/codex_rigatoni_alfredo_ws_shared_secret \
  --expected-build-identity "$COCOA_EXPECTED_BUILD_IDENTITY" \
  --verify-settings-identity

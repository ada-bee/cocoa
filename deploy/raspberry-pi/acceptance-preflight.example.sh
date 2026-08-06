#!/bin/sh
set -eu

: "${COCOA_EXPECTED_BUILD_IDENTITY:?Set the build identity baked into the deployed image}"

exec bun ../../scripts/cocoa-acceptance-preflight.ts \
  --gateway "${COCOA_GATEWAY_URL:-http://127.0.0.1:7331/}" \
  --settings ./settings.example.json \
  --ssh-identity ./secrets/id_ed25519 \
  --ssh-known-hosts ./secrets/known_hosts \
  --expected-build-identity "$COCOA_EXPECTED_BUILD_IDENTITY" \
  --verify-settings-identity

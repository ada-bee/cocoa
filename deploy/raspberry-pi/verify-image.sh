#!/bin/sh
set -eu

image_reference=${1:?Usage: verify-image.sh IMAGE_REFERENCE EXPECTED_BUILD_IDENTITY}
expected_build_identity=${2:?Usage: verify-image.sh IMAGE_REFERENCE EXPECTED_BUILD_IDENTITY}

inspect() {
  docker image inspect "$image_reference" --format "$1"
}

assert_equal() {
  label=$1
  expected=$2
  actual=$3
  if [ "$actual" != "$expected" ]; then
    echo "$label: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

assert_env() {
  expected=$1
  if ! inspect '{{range .Config.Env}}{{println .}}{{end}}' | grep -Fqx "$expected"; then
    echo "missing runtime environment entry: $expected" >&2
    exit 1
  fi
}

assert_equal architecture arm64 "$(inspect '{{.Architecture}}')"
assert_equal operating-system linux "$(inspect '{{.Os}}')"
assert_equal user '10001:10001' "$(inspect '{{.Config.User}}')"
assert_equal build-identity "$expected_build_identity" \
  "$(inspect '{{index .Config.Labels "xyz.brbc.cocoa.build-identity"}}')"
assert_equal entrypoint \
  '["/usr/bin/tini","--","bun","/opt/cocoa/dist/cocoa-bin.mjs"]' \
  "$(inspect '{{json .Config.Entrypoint}}')"
assert_equal healthcheck \
  '["CMD","bun","-e","const r=await fetch('\''http://127.0.0.1:7331/readyz'\'');if(!r.ok)process.exit(1)"]' \
  "$(inspect '{{json .Config.Healthcheck.Test}}')"

assert_env "COCOA_BUILD_IDENTITY=$expected_build_identity"
assert_env 'T3CODE_RUNTIME_PROFILE=cocoa-gateway'
assert_env 'T3CODE_HOST=0.0.0.0'
assert_env 'T3CODE_PORT=7331'
assert_env 'T3CODE_HOME=/data'
assert_env 'T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false'
assert_env 'T3CODE_NO_BROWSER=true'

scratch=$(mktemp -d)
container_id=
cleanup() {
  if [ -n "$container_id" ]; then
    docker rm "$container_id" >/dev/null 2>&1 || true
  fi
  rm -rf "$scratch"
}
trap cleanup EXIT HUP INT TERM

container_id=$(docker create --platform linux/arm64 "$image_reference")
docker export "$container_id" | tar -tf - > "$scratch/image-files.txt"

forbidden_executables=$(grep -E '(^|/)(codex|git|node(js)?|python[0-9.]*|cocoa-workspace-helper)$' \
  "$scratch/image-files.txt" \
  | grep -Ev '(^|/)node_modules/' \
  | grep -Fvx 'usr/local/bun-node-fallback-bin/node' \
  || true)
if [ -n "$forbidden_executables" ]; then
  printf '%s\n' "$forbidden_executables"
  echo 'forbidden provider-host or build executable found in gateway image' >&2
  exit 1
fi

if grep -E '(^|/)node_modules/(\.pnpm/)?(@anthropic-ai[+/]|@clerk[+/]|@opencode-ai[+/]|@t3tools[+/]tailscale|node-pty(@|/)|t3code-relay(@|/))' \
  "$scratch/image-files.txt"; then
  echo 'forbidden local-provider, hosted, or tunnel package found in gateway image' >&2
  exit 1
fi

if grep -E '(^|/)(auth\.json|credentials\.json|cocoa_ssh_identity|id_(rsa|ed25519)(\.pub)?|known_hosts)$' \
  "$scratch/image-files.txt"; then
  echo 'runtime credential material found in gateway image' >&2
  exit 1
fi

node_compatibility_target=$(docker run --rm --read-only --platform linux/arm64 \
  --entrypoint /bin/sh \
  "$image_reference" \
  -c 'readlink -f "$(command -v node)"')
assert_equal node-compatibility-target /usr/local/bin/bun "$node_compatibility_target"

help=$(docker run --rm --read-only --platform linux/arm64 \
  --entrypoint bun \
  "$image_reference" \
  /opt/cocoa/dist/cocoa-bin.mjs \
  --help)
printf '%s\n' "$help" | grep -Fq 'Run the self-hosted Cocoa gateway.'
if printf '%s\n' "$help" | grep -Eq '(^|[[:space:]])(connect|service|__service-preflight)([[:space:]]|$)'; then
  echo 'Cocoa gateway help exposes a legacy hosted or service command' >&2
  exit 1
fi

printf 'verified %s (%s)\n' "$image_reference" "$expected_build_identity"

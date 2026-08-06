{
  lib,
  stdenv,
  fetchPnpmDeps,
  pnpmConfigHook,
  pnpm_11,
  nodejs_24,
  makeBinaryWrapper,
  bun,
  src,
  buildIdentity ? "development",
}:
stdenv.mkDerivation (finalAttrs: {
  pname = "cocoa-gateway";
  version = "0.0.1";
  inherit src;

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_11;
    fetcherVersion = 4;
    pnpmWorkspaces = [
      "t3..."
      "@t3tools/web..."
      "@cocoa/gateway-runtime..."
    ];
    hash = "sha256-mbVBWvIhaKQgQ4oGkXUTMzaP6G3gFnIJxcZJCEZn6qs=";
  };

  pnpmWorkspaces = [
    "t3..."
    "@t3tools/web..."
    "@cocoa/gateway-runtime..."
  ];

  nativeBuildInputs = [
    makeBinaryWrapper
    nodejs_24
    pnpmConfigHook
    pnpm_11
  ];

  buildPhase = ''
    runHook preBuild

    pnpm --filter t3 rebuild esbuild
    pnpm --filter @t3tools/web build
    pnpm --filter t3 build:cocoa-bundle

    rm -rf apps/server/dist/client
    cp -R apps/web/dist apps/server/dist/client

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/libexec/cocoa-gateway"
    pnpm --config.inject-workspace-packages=true \
      --filter @cocoa/gateway-runtime \
      --prod \
      deploy \
      --offline \
      "$out/libexec/cocoa-gateway"

    mkdir -p "$out/libexec/cocoa-gateway/dist"
    cp apps/server/dist/*.mjs "$out/libexec/cocoa-gateway/dist/"
    cp -R apps/server/dist/client "$out/libexec/cocoa-gateway/dist/client"

    makeBinaryWrapper ${lib.getExe bun} "$out/bin/cocoa-gateway" \
      --add-flags "$out/libexec/cocoa-gateway/dist/cocoa-bin.mjs" \
      --set COCOA_BUILD_IDENTITY ${lib.escapeShellArg buildIdentity} \
      --set-default T3CODE_RUNTIME_PROFILE cocoa-gateway \
      --set-default T3CODE_HOST 0.0.0.0 \
      --set-default T3CODE_PORT 7331 \
      --set-default T3CODE_HOME /data \
      --set-default T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD false \
      --set-default T3CODE_NO_BROWSER true

    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    test -x "$out/bin/cocoa-gateway"
    test -f "$out/libexec/cocoa-gateway/dist/cocoa-bin.mjs"
    test -f "$out/libexec/cocoa-gateway/dist/client/index.html"
    for dependency in \
      @effect/platform-bun \
      @effect/platform-node \
      @effect/platform-node-shared \
      @effect/sql-sqlite-bun \
      effect \
      ws-rfc6455; do
      test -f "$out/libexec/cocoa-gateway/node_modules/$dependency/package.json"
    done
    test ! -e "$out/libexec/cocoa-gateway/node_modules/node-pty"
    test ! -e "$out/libexec/cocoa-gateway/node_modules/@anthropic-ai"
    test ! -e "$out/libexec/cocoa-gateway/node_modules/@opencode-ai"
    test ! -e "$out/libexec/cocoa-gateway/node_modules/@clerk"
    test ! -e "$out/libexec/cocoa-gateway/node_modules/@t3tools/tailscale"
    help="$($out/bin/cocoa-gateway --help)"
    printf '%s\n' "$help" | grep -q 'Run the self-hosted Cocoa gateway.'
    printf '%s\n' "$help" | grep -q -- '--host string'
    printf '%s\n' "$help" | grep -q -- '--base-dir string'
    printf '%s\n' "$help" | grep -q '^  start '
    printf '%s\n' "$help" | grep -q '^  serve '
    if printf '%s\n' "$help" | grep -Eq '(^|[[:space:]])(connect|service|__service-preflight)([[:space:]]|$)'; then
      echo "Cocoa gateway help exposes a legacy hosted or service command" >&2
      exit 1
    fi
  '';

  passthru = {
    inherit buildIdentity;
    runtime = bun;
    runtimeProfile = "cocoa-gateway";
  };

  meta = {
    description = "Cocoa gateway and bundled reference web client";
    license = lib.licenses.mit;
    platforms = [ "aarch64-linux" ];
    mainProgram = "cocoa-gateway";
  };
})

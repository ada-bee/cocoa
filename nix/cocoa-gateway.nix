{
  lib,
  stdenv,
  fetchPnpmDeps,
  pnpmConfigHook,
  pnpm_11,
  nodejs_24,
  python3,
  pkg-config,
  makeBinaryWrapper,
  bun,
  src,
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
    ];
    hash = "sha256-WKpf49J8AMga9pPmUkiXYXQzG67BgLsF9b30lOU52AI=";
  };

  pnpmWorkspaces = [
    "t3..."
    "@t3tools/web..."
  ];

  nativeBuildInputs = [
    makeBinaryWrapper
    nodejs_24
    pkg-config
    pnpmConfigHook
    pnpm_11
    python3
  ];

  buildPhase = ''
    runHook preBuild

    pnpm --filter t3 rebuild node-pty esbuild
    pnpm --filter @t3tools/web build
    pnpm --filter t3 build:cocoa-bundle

    rm -rf apps/server/dist/client
    cp -R apps/web/dist apps/server/dist/client

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/libexec"
    pnpm --config.inject-workspace-packages=true \
      --filter t3 \
      --prod \
      deploy \
      --offline \
      "$out/libexec/cocoa-gateway"

    makeBinaryWrapper ${lib.getExe bun} "$out/bin/cocoa-gateway" \
      --add-flags "$out/libexec/cocoa-gateway/dist/cocoa-bin.mjs" \
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
    help="$($out/bin/cocoa-gateway --help)"
    printf '%s\n' "$help" | grep -q 'Run the self-hosted Cocoa gateway.'
    if printf '%s\n' "$help" | grep -Eq '(^|[[:space:]])(connect|service|__service-preflight)([[:space:]]|$)'; then
      echo "Cocoa gateway help exposes a legacy hosted or service command" >&2
      exit 1
    fi
  '';

  passthru = {
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

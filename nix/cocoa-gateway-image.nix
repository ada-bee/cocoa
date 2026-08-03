{
  lib,
  dockerTools,
  runCommand,
  bun,
  openssh,
  cacert,
  tini,
  cocoaGateway,
  settingsExample ? ../deploy/raspberry-pi/settings.example.json,
}:
let
  runtimePackages = [
    bun
    openssh
    cacert
    tini
  ];
  runtimePackageNames = map lib.getName runtimePackages;
  userFiles = runCommand "cocoa-gateway-user-files" { } ''
    mkdir -p "$out/etc"
    cat > "$out/etc/passwd" <<'EOF'
    root:x:0:0:root:/root:/sbin/nologin
    cocoa:x:10001:10001:Cocoa gateway:/home/cocoa:/sbin/nologin
    EOF
    cat > "$out/etc/group" <<'EOF'
    root:x:0:
    cocoa:x:10001:
    EOF
  '';
  ociConfig = {
    User = "10001:10001";
    WorkingDir = "/data";
    Entrypoint = [
      "${lib.getExe tini}"
      "--"
      "${lib.getExe cocoaGateway}"
    ];
    Env = [
      "HOME=/home/cocoa"
      "PATH=${lib.makeBinPath runtimePackages}"
      "SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt"
      "T3CODE_RUNTIME_PROFILE=cocoa-gateway"
      "T3CODE_HOST=0.0.0.0"
      "T3CODE_PORT=7331"
      "T3CODE_HOME=/data"
      "T3CODE_NO_BROWSER=true"
    ];
    ExposedPorts."7331/tcp" = { };
    Volumes = {
      "/data" = { };
      "/tmp" = { };
    };
    Healthcheck = {
      Test = [
        "CMD"
        "${lib.getExe bun}"
        "-e"
        "const r=await fetch('http://127.0.0.1:7331/readyz');if(!r.ok)process.exit(1)"
      ];
      Interval = 30000000000;
      Timeout = 5000000000;
      Retries = 3;
      StartPeriod = 10000000000;
    };
  };
in
dockerTools.buildLayeredImage {
  name = "cocoa-gateway";
  tag = "latest";
  # Keep the target explicit so a future flake refactor cannot silently emit a
  # host-architecture image under the Raspberry Pi package name.
  architecture = "arm64";
  contents = runtimePackages ++ [
    cocoaGateway
    userFiles
  ];
  extraCommands = ''
    mkdir -p data/caches data/userdata/logs data/worktrees home/cocoa/.ssh tmp
    touch data/.cocoa-volume
    cp ${settingsExample} data/userdata/settings.json
    chown -R 10001:10001 data home/cocoa
    chmod 0700 home/cocoa home/cocoa/.ssh
    chmod 0750 data data/userdata
    chmod 0640 data/userdata/settings.json
    chmod 1777 tmp
  '';
  config = ociConfig;

  passthru = {
    inherit ociConfig runtimePackageNames;
    targetArchitecture = "arm64";
    providerHostHelperIncluded = false;
  };
}

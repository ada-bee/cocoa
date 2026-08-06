{
  description = "Cocoa gateway and provider-host packages";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "aarch64-linux";
      pkgs = import nixpkgs { inherit system; };
      lib = pkgs.lib;
      cocoaBuildIdentity = "git:${self.rev or (self.dirtyRev or "unversioned")}";

      source = lib.cleanSourceWith {
        src = self;
        filter =
          path: type:
          let
            relative = lib.removePrefix "${toString self}/" (toString path);
            excluded =
              relative == ".repos"
              || lib.hasPrefix ".repos/" relative
              || relative == "node_modules"
              || lib.hasPrefix "node_modules/" relative
              || relative == "userdata"
              || lib.hasPrefix "userdata/" relative
              || relative == "worktrees"
              || lib.hasPrefix "worktrees/" relative
              || relative == "caches"
              || lib.hasPrefix "caches/" relative;
          in
          !excluded && (type != "symlink" || builtins.pathExists path);
      };

      cocoaGateway = pkgs.callPackage ./nix/cocoa-gateway.nix {
        src = source;
        buildIdentity = cocoaBuildIdentity;
      };
      cocoaGatewayImage = pkgs.callPackage ./nix/cocoa-gateway-image.nix {
        inherit cocoaGateway;
      };
      providerHostSystems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      providerHostPackages = lib.genAttrs providerHostSystems (
        hostSystem:
        let
          hostPkgs = import nixpkgs { system = hostSystem; };
        in
        {
          cocoa-provider-host-helper = hostPkgs.callPackage ./native/cocoa-workspace-helper/package.nix { };
        }
      );

      composeText = builtins.readFile ./deploy/raspberry-pi/compose.yaml;
      gatewayPackageText = builtins.readFile ./nix/cocoa-gateway.nix;
      gatewayRuntimeManifest =
        builtins.fromJSON (builtins.readFile ./packages/cocoa-gateway-runtime/package.json);
      gatewayRuntimeDependencies = builtins.attrNames gatewayRuntimeManifest.dependencies;
      expectedGatewayRuntimeDependencies = [
        "@effect/platform-bun"
        "@effect/platform-node"
        "@effect/platform-node-shared"
        "@effect/sql-sqlite-bun"
        "effect"
        "ws-rfc6455"
      ];
      settings = builtins.fromJSON (builtins.readFile ./deploy/raspberry-pi/settings.example.json);
      imageConfig = cocoaGatewayImage.passthru.ociConfig;
      targetArchitecture = cocoaGatewayImage.passthru.targetArchitecture;
      runtimeNames = cocoaGatewayImage.passthru.runtimePackageNames;
      providerInstances = settings.providerInstances or { };
      selectedInstanceId = settings.textGenerationModelSelection.instanceId or null;
      providerHostHelperMainPrograms = map (
        hostSystem:
        providerHostPackages.${hostSystem}."cocoa-provider-host-helper".meta.mainProgram
      ) providerHostSystems;
      policyAssertions = [
        {
          assertion = system == "aarch64-linux";
          message = "gateway artifacts must target aarch64-linux";
        }
        {
          assertion = targetArchitecture == "arm64";
          message = "gateway image must declare the OCI arm64 architecture";
        }
        {
          assertion = imageConfig.User == "10001:10001";
          message = "gateway image must run as the unprivileged Cocoa user";
        }
        {
          assertion = imageConfig.ExposedPorts ? "7331/tcp";
          message = "gateway image must expose port 7331";
        }
        {
          assertion = imageConfig.Labels."xyz.brbc.cocoa.build-identity" == cocoaBuildIdentity;
          message = "gateway image must attest the source-derived Cocoa build identity";
        }
        {
          assertion = builtins.elem "T3CODE_RUNTIME_PROFILE=cocoa-gateway" imageConfig.Env;
          message = "gateway image must select the cocoa-gateway runtime profile";
        }
        {
          assertion = builtins.elem "T3CODE_HOST=0.0.0.0" imageConfig.Env;
          message = "gateway image must listen on every container interface";
        }
        {
          assertion = builtins.elem "T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false" imageConfig.Env;
          message = "gateway image must never bootstrap a provider project from its local cwd";
        }
        {
          assertion =
            lib.hasInfix "build:cocoa-bundle" gatewayPackageText
            && lib.hasInfix "dist/cocoa-bin.mjs" gatewayPackageText
            && lib.hasInfix "--filter @cocoa/gateway-runtime" gatewayPackageText
            && !(lib.hasInfix "rebuild node-pty" gatewayPackageText)
            && !(lib.hasInfix ''--filter t3 \
      --prod'' gatewayPackageText)
            && !(lib.hasInfix "build:bundle" gatewayPackageText)
            && !(lib.hasInfix "dist/bin.mjs" gatewayPackageText);
          message = "gateway package must build the dedicated Cocoa entrypoint and deploy only its minimal runtime workspace";
        }
        {
          assertion = gatewayRuntimeDependencies == expectedGatewayRuntimeDependencies;
          message = "Cocoa runtime manifest must exactly match the external imports of the production bundle";
        }
        {
          assertion = builtins.all (dependency: !(builtins.elem dependency gatewayRuntimeDependencies)) [
            "@anthropic-ai/claude-agent-sdk"
            "@clerk/backend"
            "@opencode-ai/sdk"
            "@t3tools/tailscale"
            "node-pty"
            "t3code-relay"
          ];
          message = "Cocoa runtime manifest contains a local-provider, hosted, or tunnel dependency";
        }
        {
          assertion = lib.hasInfix ''T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false"'' composeText;
          message = "gateway compose deployment must disable local cwd project bootstrap";
        }
        {
          assertion =
            lib.hasInfix
              ("$" + "{COCOA_GATEWAY_IMAGE_REPOSITORY:-cocoa-gateway}@$" + "{COCOA_GATEWAY_IMAGE_DIGEST:?")
              composeText
            && !(lib.hasInfix "cocoa-gateway:latest" composeText);
          message = "gateway compose deployment must require an operator-supplied immutable image digest";
        }
        {
          assertion =
            imageConfig.Healthcheck.Test == [
              "CMD"
              "${lib.getExe pkgs.bun}"
              "-e"
              "const r=await fetch('http://127.0.0.1:7331/readyz');if(!r.ok)process.exit(1)"
            ];
          message = "gateway image healthcheck must use core readiness";
        }
        {
          assertion = builtins.all (name: builtins.elem name runtimeNames) [
            "bun"
            "openssh"
            "nss-cacert"
            "tini"
          ];
          message = "gateway image runtime closure is missing an explicitly required package";
        }
        {
          assertion = !(builtins.elem "cocoa-provider-host-helper" runtimeNames);
          message = "provider-host helper must never be included in the gateway image";
        }
        {
          assertion = builtins.all (name: !(lib.hasPrefix "node" name)) runtimeNames;
          message = "gateway image must use Bun without adding a Node.js runtime";
        }
        {
          assertion = builtins.all (mainProgram: mainProgram == "cocoa-workspace-helper") providerHostHelperMainPrograms;
          message = "every provider-host helper package must expose cocoa-workspace-helper";
        }
        {
          assertion = builtins.all (needle: !(lib.hasInfix needle composeText)) [
            "/var/run/docker.sock"
            "workspace:"
            "codex_home"
            "provider_credentials"
          ];
          message = "gateway compose file contains a forbidden host/provider mount";
        }
        {
          assertion = builtins.all (needle: lib.hasInfix needle composeText) [
            "read_only: true"
            "- bun"
            "/readyz"
            "/tmp:rw,nosuid,nodev,noexec"
            "/data/userdata/logs:rw,nosuid,nodev,noexec"
            "/data/worktrees:rw,nosuid,nodev,noexec"
            "/data/caches:rw,nosuid,nodev,noexec"
          ];
          message = "gateway compose file must mask non-durable paths with writable tmpfs mounts";
        }
        {
          assertion = builtins.length (builtins.attrNames providerInstances) == 2;
          message = "example settings must define exactly the two initial provider endpoints";
        }
        {
          assertion =
            selectedInstanceId != null
            && builtins.hasAttr selectedInstanceId providerInstances
            && (providerInstances.${selectedInstanceId}.enabled or false);
          message = "example model selection must reference an enabled explicit provider instance";
        }
        {
          assertion = builtins.all (
            provider:
            provider.driver == "codex"
            && provider.config.endpointTransport.type == "ssh-proxy"
            && provider.config.endpointTransport.options.strictHostKeyChecking == "yes"
            && provider.config.workspaceHelper.type == "inline-python3-v1"
            && lib.hasPrefix "/" provider.config.workspaceHelper.executablePath
            && lib.hasPrefix "/" provider.config.endpointGitExecutablePath
            && provider.config.checkpointHelper.type == "cocoa-checkpoint-helper-v1"
            && provider.config.checkpointHelper.expectedProtocol == 1
            && lib.hasSuffix "/bin/cocoa-workspace-helper" provider.config.checkpointHelper.executablePath
            && provider.config.endpointTerminal == {
              enabled = true;
              sandboxMode = "workspaceWrite";
            }
          ) (builtins.attrValues providerInstances);
          message = "example providers must explicitly configure remote transport and capabilities";
        }
      ];
      failedAssertions = builtins.filter (entry: !entry.assertion) policyAssertions;
      policyCheck =
        if failedAssertions != [ ] then
          throw (lib.concatMapStringsSep "; " (entry: entry.message) failedAssertions)
        else
          pkgs.runCommand "cocoa-packaging-policy" { } ''
            touch "$out"
          '';
      imageContentCheck = pkgs.runCommand "cocoa-gateway-image-content-policy" {
        nativeBuildInputs = [
          pkgs.gnutar
          pkgs.gzip
          pkgs.jq
        ];
      } ''
        mkdir unpacked
        tar -xzf ${cocoaGatewayImage} -C unpacked

        config_file="$(${lib.getExe pkgs.jq} -er \
          'if length == 1 then .[0].Config else error("expected one image manifest") end' \
          unpacked/manifest.json)"
        if [[ ! "$config_file" =~ ^[0-9a-f]+\.json$ || ! -f "unpacked/$config_file" ]]; then
          echo "image config is missing or escapes the archive root" >&2
          exit 1
        fi
        ${lib.getExe pkgs.jq} -e \
          '.architecture == "arm64" and .os == "linux"' \
          "unpacked/$config_file" >/dev/null

        find unpacked -type f -name layer.tar -print0 \
          | while IFS= read -r -d $'\0' layer; do
              tar -tf "$layer"
            done > image-files.txt

        if grep -E '/(codex|git|node(js)?|python[0-9.]*|cocoa-workspace-helper)$' image-files.txt; then
          echo "forbidden provider-host executable found in gateway image" >&2
          exit 1
        fi

        if grep -E '(^|/)node_modules/(\.pnpm/)?(@anthropic-ai[+/]|@clerk[+/]|@opencode-ai[+/]|@t3tools[+/]tailscale|node-pty(@|/)|t3code-relay(@|/))' image-files.txt; then
          echo "forbidden local-provider, hosted, or tunnel package found in gateway image" >&2
          exit 1
        fi

        if grep -E '(^|/)(auth\.json|credentials\.json|cocoa_ssh_identity|id_(rsa|ed25519)(\.pub)?|known_hosts)$' image-files.txt; then
          echo "runtime credential material found in gateway image" >&2
          exit 1
        fi

        touch "$out"
      '';
    in
    {
      packages = providerHostPackages // {
        ${system} = providerHostPackages.${system} // {
          cocoa-gateway = cocoaGateway;
          cocoa-gateway-image = cocoaGatewayImage;
          default = cocoaGatewayImage;
        };
      };

      checks.${system} = {
        inherit (self.packages.${system}) cocoa-gateway cocoa-gateway-image;
        image-content-policy = imageContentCheck;
        packaging-policy = policyCheck;
      };
    };
}

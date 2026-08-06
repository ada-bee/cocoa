{
  description = "Cocoa provider-host helper packages";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      packages = nixpkgs.lib.genAttrs systems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          helper = pkgs.callPackage ./native/cocoa-workspace-helper/package.nix { };
        in
        {
          cocoa-provider-host-helper = helper;
          default = helper;
        }
      );
    in
    {
      inherit packages;
      checks = nixpkgs.lib.genAttrs systems (system: {
        cocoa-provider-host-helper = self.packages.${system}.cocoa-provider-host-helper;
      });
    };
}

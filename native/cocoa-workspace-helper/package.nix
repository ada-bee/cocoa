{
  lib,
  rustPlatform,
}:

rustPlatform.buildRustPackage {
  pname = "cocoa-workspace-helper";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./Cargo.lock
      ./Cargo.toml
      ./src
      ./tests
    ];
  };

  cargoLock.lockFile = ./Cargo.lock;

  meta = {
    description = "Bounded workspace reads and transactional Git checkpoints for Cocoa provider hosts";
    license = lib.licenses.mit;
    mainProgram = "cocoa-workspace-helper";
    platforms = lib.platforms.unix;
  };
}

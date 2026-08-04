{
  lib,
  rustPlatform,
  git,
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

  # Integration tests construct disposable repositories. Git is supplied only
  # while checking the package; production requests still use the explicit
  # provider-host executable path carried by the CCH1 request.
  nativeCheckInputs = [ git ];

  meta = {
    description = "Bounded workspace reads and transactional Git checkpoints for Cocoa provider hosts";
    license = lib.licenses.mit;
    mainProgram = "cocoa-workspace-helper";
    platforms = lib.platforms.unix;
  };
}

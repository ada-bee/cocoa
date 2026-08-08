# Cocoa for iOS

This is Cocoa's native SwiftUI client for iPhone and iPad. It targets iOS 17 or
later, talks only to a user-paired Cocoa gateway, and contains no Clerk, relay,
hosted identity, or T3 Connect client. Pairing credentials are exchanged with the
gateway and stored in the iOS Keychain.

The app deliberately persists one gateway. Pairing a replacement removes the
previous gateway and its credential after the new pairing succeeds.

## Build an unsigned IPA

Run:

```sh
./Scripts/build-unsigned-ipa.sh
```

The default output is `build/Cocoa-unsigned.ipa`. The script builds an arm64
iPhoneOS Release app with code signing disabled, packages only `Cocoa.app`, and
verifies that no app extensions, signature, or provisioning profile are present.
It does not start a simulator and does not require an Apple Developer account.

Pass a different output path as the first argument if needed:

```sh
./Scripts/build-unsigned-ipa.sh /tmp/Cocoa.ipa
```

Feather can import and sign the resulting IPA on device. The release identity is
`xyz.brbc.cocoa` and its URL scheme is `cocoa`.

## Project layout

- `App` — lifecycle and gateway-backed feature adapter
- `Core` — pairing, Keychain persistence, HTTP, and WebSocket RPC
- `Features` — native onboarding, workspace, conversations, files, Git, terminal,
  review, devices, and settings
- `DesignSystem` — shared SwiftUI styling
- `Resources` — app icon, provider art, privacy manifest, and Info.plist
- `Tests` — protocol, persistence, transport, and feature tests

The Xcode target remains named `T3Code` internally so the imported upstream test
module stays stable; the built product and user-visible application are `Cocoa`.
The unsigned builder rasterizes the repository's `assets/cocoa-icon.svg` directly;
the asset-catalog PNGs mirror it for ordinary Xcode builds.

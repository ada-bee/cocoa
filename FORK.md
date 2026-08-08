# Cocoa fork policy

Cocoa is a downstream fork of [T3 Code](https://github.com/pingdotgg/t3code). Its purpose is to turn the upstream application into a modular, self-hosted control plane for independently operated Codex app-server daemons.

Upstream owns the common product. Cocoa owns only the architectural differences listed below. Keeping a Cocoa implementation when upstream has an equivalent is a bug unless an intentional divergence requires it.

## Upstream by default

- Import upstream fixes. Security, privacy, data-loss, corruption, compatibility, recovery, accessibility, and material performance fixes are mandatory intake unless the affected subsystem is absent from Cocoa.
- Import upstream features by default. Reject a feature only when it requires hosted T3 infrastructure, weakens self-hosting, moves provider-owned work onto the gateway, or conflicts with another intentional divergence in this file.
- Prefer upstream code, names, files, contracts, tests, and dependencies over Cocoa equivalents. When upstream implements behavior Cocoa already carries, remove the Cocoa implementation, take upstream's implementation, and keep only the smallest Cocoa adapter required at the remote-provider boundary.
- Do not preserve a custom implementation merely because it landed first or fits the current tree with fewer conflicts. Long-term ownership and future upstream fixes matter more than short-term merge convenience.
- Keep Cocoa changes narrow and layered behind upstream seams. Avoid cosmetic rewrites, broad file moves, generated-code edits, and fork-only abstractions in shared product code.
- A merge conflict is not a reason to reject an upstream change. It is a prompt to identify the real boundary and reduce the Cocoa side of the conflict.

## Intake cadence

The scheduled `Upstream intake` workflow checks `upstream/main` every Monday. An intake is also required:

- before every Cocoa release;
- immediately for a relevant security advisory or severe correctness fix;
- when upstream changes Codex protocol support, persistence, recovery, client contracts, or a dependency Cocoa shares;
- before starting substantial work in an area that upstream has changed since the last review.

A failed scheduled check means upstream contains unreviewed commits. It is an actionable maintenance signal, not an allowed permanent CI state.

## Intake procedure

Use `upstream` for `https://github.com/pingdotgg/t3code.git`. Set it up once if necessary:

```sh
git remote add upstream https://github.com/pingdotgg/t3code.git
git fetch --tags upstream main
```

Never run `git pull upstream main` directly on Cocoa's `main`. Instead:

1. Start from a clean, current Cocoa `main` and create an intake branch named `upstream/YYYY-MM-DD`.
2. Run `bun scripts/cocoa-upstream-forecast.ts --fetch`. Review every commit after the recorded horizon, including commits forecast to merge cleanly.
3. Read the patches and classify them in `upstream-intake.json` as `imported`, `deferred`, or `skipped`.
4. Merge a contiguous compatible upstream window when practical so Git retains the true ancestry. For isolated commits, cherry-pick with `-x`. Keep Cocoa conflict adaptation in a following commit when it cannot be expressed as a small merge resolution.
5. When an upstream change overlaps Cocoa code, first restore the upstream implementation and delete the duplicate. Reapply only the provider-routing, no-cloud, authentication, branding, or packaging delta justified by the divergence ledger below.
6. Run the smallest focused upstream tests plus Cocoa tests at every adapted boundary. Protocol, persistence, authentication, provider routing, or recovery changes require focused integration coverage.
7. Record a contiguous reviewed horizon in `upstream-intake.json`. An `imported` entry must point at a Cocoa commit that proves either `-x` provenance or merge ancestry. A `skipped` reason must name an intentional divergence from this file. A `deferred` reason must state the concrete prerequisite or review trigger; deferred entries are reconsidered at every intake.
8. Run `bun scripts/cocoa-upstream-forecast.ts` again. Finish only when it reports no unreviewed commits and every imported commit is present on the intake branch.

Do not combine an upstream implementation with an independently rewritten Cocoa version in one commit: that obscures provenance and makes later replacement harder.

## Intentional divergences

These are the only standing reasons to maintain fork-specific behavior. Additions require an explicit architecture decision and an update to this file.

| Area                                     | Cocoa's intentional choice                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment topology                      | Clients connect only to a Cocoa gateway. The gateway connects to configured remote Codex/provider endpoints. Clients never connect directly to provider daemons.                                                                                                                                                                                                                                            |
| Provider process ownership               | Provider processes are external and independently supervised. The gateway does not install, discover, spawn, update, or supervise a local agent CLI.                                                                                                                                                                                                                                                        |
| Authority and history                    | Provider endpoints are authoritative for live execution and provider-owned mutations. Cocoa SQLite is the durable aggregate archive for complete provider conversation history plus Cocoa-owned overlays and journals. Provider absence never deletes archived data.                                                                                                                                        |
| Project identity                         | A project is identified by provider instance and remote workspace path. A remote path is opaque to the gateway and is never resolved against the gateway filesystem.                                                                                                                                                                                                                                        |
| Workspace, execution, terminals, and VCS | All project operations resolve a provider instance and execute through normalized provider capabilities. The `cocoa-hostd` control protocol and bounded workspace/checkpoint helpers are Cocoa-owned execution-plane adapters until upstream offers equivalent remote capabilities. Generic process, stream, PTY, and VCS primitives are not fork-owned and must reuse or extract upstream implementations. |
| Network boundary                         | Administrators configure ordinary network endpoints and own LAN, VPN, TLS, reverse-proxy, and routing setup. Cocoa provides no tunnel, relay, endpoint discovery, or hosted fleet management.                                                                                                                                                                                                               |
| Authentication                           | Gateway access uses Cocoa-owned self-hosted authentication and device sessions, or an explicit administrator-selected no-auth mode. It does not depend on Clerk, T3 accounts, or hosted identity.                                                                                                                                                                                                           |
| Provider scope                           | Codex is first-class. Other upstream providers may remain where they are cheap to carry, but Cocoa does not preserve feature parity or add dependencies solely for them.                                                                                                                                                                                                                                    |
| Client API                               | `packages/contracts` and `packages/cocoa-client` expose a versioned gateway boundary for generic web, desktop, mobile, and custom clients. Provider-native protocols stay behind the gateway.                                                                                                                                                                                                               |
| Lifecycle and packaging                  | Cocoa ships an administrator-managed gateway container and separately managed host daemon binaries. Upstream launcher self-update and managed-service lifecycle behavior is not inherited.                                                                                                                                                                                                                  |
| Product surfaces                         | Cocoa branding and the native Swift client are fork-owned. Their interaction semantics should still reuse upstream behavior and tests wherever the gateway contract permits.                                                                                                                                                                                                                                |
| Public cloud and community surfaces      | Hosted T3 product, marketing, relay, fleet, telemetry, release, and contributor workflows are not part of the Cocoa runtime or release process. Shared product fixes from those areas should still be extracted when applicable.                                                                                                                                                                            |

## Not intentional divergences

The following normally stay aligned with upstream: visual and interaction behavior, accessibility, performance work, generic orchestration semantics, Codex event normalization, protocol generation, dependency upgrades, editor and terminal ergonomics, and shared web/mobile/desktop components.

Differences in these areas need a local constraint tied to the ledger above. Otherwise, replace them with upstream during the next intake.

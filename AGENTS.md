# Cocoa

Cocoa is a personal fork of T3 Code. It is becoming a modular, self-hosted control plane for independently operated Codex app-server daemons.

## Direction

The target deployment is:

```text
web / desktop / mobile clients
              |
              v
Cocoa gateway + web app + SQLite
              |
              v
remote Codex app-server daemon(s)
              |
              v
workspace, Git, shell, and tools on the Codex host
```

- Provider endpoints are authoritative for live thread execution and provider-owned mutations. Cocoa must route those mutations to the endpoint before recording local consequences.
- The gateway database is the durable aggregate archive for provider conversation catalogs and complete conversation history. It reconciles through endpoint-event invalidation and periodic full sweeps; a failed sweep keeps stale history, provider absence never deletes archived data, and a sweep is fresh only after full details are stored.
- Cocoa automatically materializes a durable project for each `(provider instance, remote workspace path)` observed in provider history. Provider disconnection or provider-side cleanup never removes Cocoa projects or their archived conversations.
- The gateway durably owns Cocoa-only overlays and journals: projects, settle/snooze state, runtime bindings, dispatch receipts, checkpoint state, authentication, and client API state. Event-sourced orchestration is not an independent source of provider conversation history.
- Codex is the first-class provider. Other provider integrations may remain in history, but do not preserve feature parity or add new dependencies for them.
- Provider processes are always external. The gateway must not install, discover, spawn, or supervise a local agent CLI.
- A Codex provider instance is a configured network endpoint. It supplies conversations as well as normalized filesystem, process, terminal, and VCS operations.
- Projects are identified by both provider instance and remote workspace path. Never interpret a remote workspace path on the gateway host.
- Clients talk only to the gateway and remain generic reference clients. They never connect directly to a provider daemon.
- Cocoa does not provide tunnels, relays, hosted identity, endpoint discovery, or fleet management. Administrators own LAN, VPN, TLS, reverse-proxy, and routing setup.

Prefer adapting upstream boundaries over rewriting them. Keep the decider and projector pure, put provider-specific behavior behind adapters, and keep UI state derived from gateway contracts.

## Code map

- `apps/server` — gateway, orchestration, provider adapters, persistence, checkpointing, filesystem, VCS, and terminals.
- `apps/web` — React/Vite reference client; desktop wraps it.
- `apps/mobile` — React Native reference client.
- `packages/contracts` — schemas for every client/gateway boundary.
- `packages/client-runtime` — shared client connection and state logic.
- `.repos` — vendored read-only references. Never edit or import from them.

Anything crossing a network boundary must be typed in `packages/contracts`. Workspace operations must resolve a provider instance before touching a path.

## Working rules

- Use the existing Effect services and queue-backed orchestration patterns. Read `.repos/effect-smol/LLMS.md` before substantial Effect changes.
- Preserve performance: avoid oversized WebSocket payloads, unbounded replay, needless rerenders, and continuously repainting animation.
- Preserve remote correctness: reconnects, multiple clients, multiple Codex endpoints, and provider/version skew are normal states.
- Do not add public-facing documentation or contributor-process files unless explicitly requested. Keep durable project guidance concise and in this file.
- Never run a development server against `~/.t3/userdata`; use worktree-local `.t3` state.
- Never kill processes by name or path pattern. Stop only a PID captured at spawn or a verified listener owner.
- Do not set `VITE_HTTP_URL` or `VITE_WS_URL` in development; the clients use same-origin HTTP/WSS and Vite proxies.

## Verification

- Install with `vp i` and use the existing `vp run` scripts.
- Run the smallest focused tests, lint, and typecheck that prove the change.
- Do not run repository-wide checks unless explicitly requested.
- Backend behavior changes require focused tests. Wait on receipts and worker drains, never sleeps or polling.
- Ask before starting browsers, simulators, or computer-use verification.
- Do not create a pull request unless explicitly requested.

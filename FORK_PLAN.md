# Cocoa Fork Plan

## Goal

Cocoa turns T3 Code into a modular, self-hosted control plane for coding agents.
The first supported topology is:

```text
iPhone / web / desktop clients
              |
              | Cocoa client protocol
              v
Raspberry Pi: Cocoa gateway + web app + SQLite
              |
              | authenticated Codex app-server protocol
              v
independent Codex hosts: standalone daemon + repositories + tools + credentials
```

The administrator owns connectivity between every component. Cocoa listens on a
normal network port and connects to configured provider endpoints. It does not
provide tunnels, relays, endpoint discovery, hosted identity, or fleet
management.

The initial provider hosts are a macOS arm64 laptop at `192.168.20.99` and an
x86_64 Linux development host at `192.168.20.61`. Both run Codex's experimental
standalone daemon in remote-control mode. Cocoa must integrate with that daemon;
it must not replace its lifecycle manager or start a second daemon.

There is no Cocoa production data to migrate during the initial fork. Contract,
event, and projection changes may therefore be direct, required cutovers without
legacy decoding defaults or data backfills.

The aim is to retain the strong parts of upstream T3 Code—its event-sourced
orchestration, projections, typed contracts, provider normalization, responsive
clients, and recovery model—while removing the assumption that the gateway and
agent harness run on the same machine.

## Product boundary

### Gateway

The gateway owns:

- SQLite persistence and migrations
- commands, events, deciders, projections, reactors, and receipts
- normalized threads, turns, approvals, activity, and checkpoints
- configured provider-instance metadata and connection health
- authentication and the stable client-facing protocol
- serving the reference web app
- temporary ingress for client uploads

The gateway must not require:

- a Codex binary or other provider CLI
- Codex account credentials or model-provider API credentials
- repository or workspace mounts
- local Git, shell, PTY, or filesystem access for a project
- permission to spawn or supervise a provider process

The gateway does hold the credentials needed to reach a configured endpoint,
such as an SSH identity or a WebSocket capability token. A transport helper such
as `ssh` is not a provider process: Cocoa may own that connection process, but it
must never start, stop, update, discover, or supervise the remote Codex daemon.

### Provider host

The provider host owns:

- the Codex app-server daemon and its credentials
- repositories and workspace files
- Git state and checkpoint refs
- commands, terminals, tools, and sandbox policy
- the provider-native thread state needed for recovery

### Clients

Web, mobile, and desktop are generic Cocoa clients. They connect only to the
gateway and consume the normalized Cocoa contract. A client never needs a
provider endpoint, provider credentials, or direct knowledge of the Codex
protocol.

Keep the existing Effect RPC contracts and `packages/client-runtime` initially.
They already form a typed client API used by all three reference apps. Stabilize
and document that boundary before considering an additional REST/SSE facade or a
generated SDK.

## First-class provider model

Codex is the only first-class provider during the fork. Provider-neutral domain
objects should remain where they make the gateway simpler, but Cocoa does not
promise feature parity with Claude Code, Cursor, Grok, or OpenCode.

Keep the existing `CodexDriver`, `ProviderInstance`, and
`ProviderInstanceRegistry`; they already provide independently scoped,
multi-instance routing. Register only Codex in the Cocoa runtime. Leave other
provider implementations in history or unregistered source while that reduces
conflicts with useful upstream changes, and prune them only when their runtime
dependencies impose a real cost. OpenCode can return later as a second remote
provider without shaping the first architecture.

Avoid replacing the current provider abstraction with one giant remote-agent
interface. A configured provider instance should expose focused capabilities:

```ts
interface ProviderInstance {
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  adapter: ProviderSessionAdapter;
  workspace?: ProviderWorkspaceAdapter;
  execution?: ProviderExecutionAdapter;
  vcs?: ProviderVcsAdapter;
}
```

Unsupported capability groups should be explicit. Complexity belongs in these
adapters; commands, events, and client projections should remain provider-normal.

## Provider configuration

A provider is a durable, administrator-configured endpoint. The first deployed
transport connects over SSH to `codex app-server proxy`, which forwards the
protocol to the already-running standalone daemon's Unix control socket:

```yaml
server:
  listen: 0.0.0.0:7331

database:
  path: /data/state.sqlite

providers:
  - id: codex-macbook-air
    type: codex
    transport:
      type: ssh-proxy
      host: 192.168.20.99
      user: ada-bee
  - id: codex-linux-mv
    type: codex
    transport:
      type: ssh-proxy
      host: 192.168.20.61
      user: ada-bee
```

Direct WebSocket is a second transport for explicitly exposed daemons. Codex
0.146.0 supports `capability-token` and `signed-bearer-token` authentication for
non-loopback WebSocket listeners; administrator-owned TLS termination supplies
WSS when needed. Authentication modes must be modeled explicitly rather than as
a generic bearer token.

There should be no provider `binaryPath`, `homePath`, daemon launch arguments,
process discovery, or daemon spawn mode in gateway configuration. The SSH
transport runs one fixed proxy command and may expose ordinary SSH connection
options; those settings configure the protocol connection, not the daemon.

`ProjectId` remains the durable aggregate identity. A project's provider-owned
location and active uniqueness key changes from a local path to the tuple:

```text
(providerInstanceId, workspaceRoot)
```

`workspaceRoot` is meaningful to the provider host only. Gateway code must not
resolve it, stat it, join it to a local home directory, or pass it to local Git.

## Remote Codex transport

Introduce one long-lived `CodexEndpoint` per configured provider instance. Do
not deduplicate instances by URL or host initially: authentication, connection-
scoped command IDs, health, and protocol capabilities belong to the instance.

Put transport below the endpoint. Both initial transports produce the same
WebSocket message stream:

- `ssh-proxy` opens a non-interactive SSH connection and runs the fixed remote
  `codex app-server proxy` command. The proxy carries a raw WebSocket HTTP
  upgrade and WebSocket frames over its stdio; it is not a JSONL transport and
  cannot be passed directly to the existing child-process JSON-RPC client.
- `websocket` connects directly to an administrator-exposed authenticated
  `ws://` or `wss://` listener.

The endpoint owns:

- transport and WebSocket lifecycle plus endpoint authentication
- one Codex `initialize` / `initialized` negotiation per connection
- JSON-RPC request IDs, correlation, cancellation, and timeouts
- one global set of native notification and server-request handlers
- concurrent scoped execution of inbound server requests, so an approval waiting
  on a user does not block the sole frame-reader fiber
- multiplexing by Codex thread ID and connection-scoped command ID
- bounded buffering for notifications that race native thread registration
- connection health, backoff, reconnect, and observable status
- protocol compatibility at a single boundary

The protocol layer's raw request/notification taps must be opt-in and bounded.
The current always-on unbounded queues leak on a long-lived daemon connection when
no debug consumer drains them; endpoint work must correct that seam before the
shared connection is enabled.

One endpoint connection should support many Cocoa projects and Codex threads.
The existing session runtime should borrow a routed view of the shared endpoint;
it must no longer spawn a Codex app-server or own the underlying connection.

Codex app-server currently exposes the primitives Cocoa needs, including its
thread/turn API and experimental filesystem and command methods. The
known workspace surface includes file reads and writes, directory operations,
metadata, watching, command execution, PTY input/resizing/termination, and
process output notifications. Treat the remote WebSocket listener and workspace
methods as version-sensitive. Codex 0.146.0 is the initial tested baseline, not a
permanent exact-version requirement. Record the initialized server version,
probe required and optional methods, downgrade optional capabilities on
`method not found`, and isolate all native protocol/version branches inside the
Codex endpoint and adapter. Reject a connection only when a capability required
by the requested Cocoa operation is absent.

On disconnect, fail pending requests exactly once and never transparently replay
mutating calls such as `turn/start`, filesystem writes, Git operations, or command
execution. After a fresh initialize handshake, orchestration decides which
durable threads to reconcile. Authentication/configuration failures do not enter
a rapid retry loop; transient transport failures use bounded exponential backoff
with jitter.

## Workspace operations

Move every project-scoped operation behind the provider instance:

- directory listing, search, metadata, reads, writes, copies, and removal
- repository discovery and project validation
- attachment materialization and cleanup
- shell commands and long-lived terminals
- Git status, diff, branches, commits, and checkpoint refs

Use Codex app-server workspace methods only when their declared semantics are safe
for the requested operation. In the initial 0.146.0 baseline, `fs/readFile` returns
an unbounded whole-file base64 payload, `fs/getMetadata` reports no byte size, and
the absolute-path API has no root-scoped canonicalization primitive. It therefore
cannot be the containment or bounded-I/O boundary for arbitrary project files.
Legacy `fs/readFile` must not be used for file preview. Add and capability-probe
the narrowest provider-host operation that performs root-relative containment and
bounded reads on the host; if it is unavailable, report the workspace operation as
unsupported. Do not add a gateway-to-host file-sharing protocol, mount the remote
workspace into the Pi container, or fall back to the gateway filesystem.

Client-facing workspace operations take a `ProjectId` plus a relative path, not
an arbitrary host path. The gateway resolves the project to its provider
instance, and the provider workspace adapter performs canonicalization and
containment on the provider host. Validation must account for `..`, absolute
paths, and symlink escapes. If Codex's filesystem API cannot prove containment,
add the narrowest host-side capability that can; never recreate gateway-local
path resolution for a remote workspace.

### Attachments

Use an explicit staged flow:

1. The client uploads bytes to a temporary gateway object.
2. The gateway selects a managed attachment directory on the provider host.
3. The workspace adapter creates the directory and writes the file remotely.
4. The turn references the provider-host path.
5. A reactor cleans up expired staged files.

The remote attachment base directory must come from endpoint configuration or a
reported capability. Never infer it from the gateway filesystem.

### Terminals and commands

Model terminal identity as endpoint-bound remote state. Use Codex's
`command/exec`, `command/exec/write`, `command/exec/resize`, and
`command/exec/terminate` family for the tested protocol; do not assume a callable
`process/spawn` client method merely because process notifications exist in the
generated schemas. Stream output through the
gateway using the existing receipt/event machinery and apply bounded buffering so
a slow phone cannot exhaust gateway memory.

Until Codex can safely enumerate or reattach live processes, a gateway restart may
mark terminals disconnected instead of pretending they survived. Turns and
durable conversation state have stronger recovery guarantees than ephemeral PTYs.

### Git and checkpoints

Git objects and hidden checkpoint refs live beside the repository on the provider
host. SQLite stores logical checkpoint IDs plus the provider instance, workspace,
and provider-native ref metadata. Create, diff, restore, and delete operations go
through `ProviderVcsAdapter`.

Start with carefully constructed, non-interactive Git commands executed remotely
behind the adapter. Before committing to this path, test whether the Codex daemon's
sandbox permits the required `.git` mutations. If it does not, add the narrowest
provider-host capability that can perform checkpoint operations; do not move Git
back into the gateway.

## Recovery model

There are two independent network connections:

```text
client <-> Cocoa gateway <-> Codex endpoint
```

A client disconnect must not interrupt an active turn. The gateway continues to
persist provider notifications and clients rebuild state from projections when
they reconnect.

After a gateway-to-Codex reconnect:

1. Re-authenticate and initialize the endpoint.
2. Resume or read every active native thread.
3. Fetch authoritative thread state, including turns and final items.
4. Reconcile it with Cocoa's persisted projection idempotently.
5. Restore notification routing and mark endpoint health.

Do not rely on Codex replaying notifications that were emitted while disconnected.
Codex's persisted thread snapshots are explicitly lossy and do not retain every
agent interaction, including some command executions. Cocoa therefore defines a
recoverable durable subset for the tested protocol: final user and assistant
messages, native turn identity and terminal status, and any other fields proven
authoritative by compatibility tests. Missed non-recoverable activity is recorded
as a reconciliation gap rather than silently fabricated.

The acceptance guarantee is convergence without duplicates for that recoverable
subset, not lossless replay of every native notification. Reconciliation tests
should cover duplicate final events, missing deltas, a turn finishing while
offline, approval or user-input waits across disconnect, an explicit activity
gap, and a daemon restart that loses ephemeral process state. A future stronger
guarantee requires a provider-side sequenced event journal or replay cursor.

## Migration phases

### Phase 0: Freeze the intended boundary

- Record a dependency map of every local filesystem, Git, shell, PTY, provider
  spawn, relay, tunnel, and hosted-auth call site.
- Add an explicit architecture allowlist for existing gateway Codex spawning and
  local project-path access. Tests prevent new call sites; each later phase
  shrinks the allowlist until it is empty.
- Capture focused upstream behavior tests for commands, events, projections,
  receipts, turn recovery, approvals, and checkpoints.
- Record Codex 0.146.0 as the first tested baseline and define required versus
  optional protocol capabilities. Do not require exact equality long-term.
- Add a protocol compatibility matrix covering the baseline, additive forward
  skew, missing-method backward skew, and malformed required responses.
- Record the initial read-only host matrix and confirm transport without changing
  either standalone daemon.

Exit condition: the preserved behavior and forbidden dependencies are executable
checks, not only design notes.

### Phase 1: Provider-bound projects

- Add required `providerInstanceId` to project commands, events, projections, and
  client state. Keep `ProjectId` as the durable identity.
- Make `(providerInstanceId, workspaceRoot)` the active uniqueness key and enforce
  that every thread model selection belongs to its project's instance.
- Because the database is disposable, make a direct required schema cutover with
  no data backfill or compatibility default.
- Remove gateway-local normalization, stat/create, repository-identity probing,
  and cwd autobootstrap from the remote project path.
- Represent a resolved thread workspace as an endpoint-bound target rather than a
  naked path string.
- Capability-gate automatic worktree, checkpoint, VCS, favicon, setup-script, and
  text-generation behavior until its remote adapter exists.
- Add a provider-instance picker and existing-path project creation flow; never
  browse the gateway filesystem for a remote provider.

Exit condition: two provider instances may contain the same path without identity
collisions, and merely creating or viewing either project never accesses that path
on the gateway.

### Phase 2: Shared remote Codex endpoint

- Extract native JSON-RPC handling from process management.
- Implement the framed transport abstraction with SSH proxy first and direct
  authenticated WebSocket second.
- Implement one scoped `CodexEndpoint` per provider instance, with one global set
  of native handlers and bounded thread/request multiplexing.
- Route provider health, account/model probes, and existing Codex session traffic
  through the shared endpoint.
- Validate a project's remote root with the provider workspace capability before
  starting its first session.
- Delete or disable local Codex discovery, spawning, and supervision.
- Surface endpoint health and protocol mismatch through normalized gateway state.

Exit condition: a gateway with no Codex binary can create and resume a basic turn
on a separately managed standalone Codex daemon through `app-server proxy`, and
two fake endpoints prove correct routing for the same workspace path.

### Phase 3: Remote workspace browsing

- Implement filesystem capabilities in `ProviderWorkspaceAdapter`.
- Route project discovery, directory browsing, file metadata, and reads through it.
- Capability-gate a provider-host root-relative workspace operation. It must
  confine the operation on the provider host and bound file and directory results
  before they cross the shared endpoint connection.
- Treat the 0.146.0 absolute-path filesystem methods as version-sensitive
  interoperability primitives, not proof of containment. Never call its legacy
  unbounded `fs/readFile` for an arbitrary project path.
- Add capability-aware errors for unsupported or disconnected endpoints.
- Remove direct gateway filesystem access for project operations.

Exit condition: the Pi container can browse and read a Mac-only repository without
mounting it.

### Phase 4: Turns and reconciliation

- Complete remote thread creation, resume, approval, cancellation, and streaming.
- Multiplex many threads over the shared endpoint.
- Add authoritative reconnect reconciliation and idempotency tests.
- Preserve the upstream event store/projector model rather than mirroring native
  provider objects directly into clients.

Exit condition: active work survives client disconnection and converges correctly
for the documented recoverable subset after a temporary gateway-to-Codex
interruption; unrecoverable activity is marked as a gap.

### Phase 5: Attachments and provider utilities

- Add temporary client-to-gateway uploads.
- Materialize attachments through the remote workspace adapter.
- Pass only provider-host paths to Codex and clean up safely.
- Replace `CodexTextGeneration`'s local `codex exec` path for thread titles,
  branch names, commit messages, and PR text with an endpoint-backed operation.
  Until that exists, return an explicit unsupported/error result; never fall back
  to spawning a gateway-local Codex CLI.

Exit condition: an iPhone can attach a file to a turn without a shared filesystem.
All Codex-backed utility generation also runs on the selected provider host.

### Phase 6: Remote execution and terminals

- Implement normalized command and terminal APIs over the Codex `command/exec`
  family.
- Add backpressure, cancellation, resize, exit, and disconnect semantics.
- Remove local shell and PTY execution from gateway project flows.

Exit condition: terminal and command UI operate against either provider host while
the gateway runs on the Pi.

### Phase 7: Remote VCS and checkpoints

- Implement status, diff, branches, and checkpoint operations through
  `ProviderVcsAdapter`.
- Store logical checkpoint metadata in SQLite and native refs remotely.
- Prove create/diff/restore across reconnects and gateway restarts.
- Remove local Git assumptions from checkpoint reactors.

Exit condition: Cocoa can inspect and restore remote work without Git or repository
data in the gateway container.

### Phase 8: Remove product-fleet coupling

- Disable and then prune unsupported provider integrations and dependencies.
- Remove T3 Connect, relay, hosted identity, and cloud endpoint/fleet flows.
- Replace product-specific onboarding with direct gateway configuration and pairing.
- Keep web, mobile, and desktop as reference clients of the same gateway contract.

Exit condition: the runtime has no required hosted T3 service and offers no custom
tunnel path.

### Phase 9: Self-hosted packaging

- Produce an ARM64-compatible gateway + web container.
- Persist only SQLite, gateway configuration, and managed temporary uploads.
- Add health/readiness endpoints for the gateway and configured provider endpoints.
- Document configuration through generated help and example deployment files kept
  close to the packaging code rather than restoring a public documentation site.

Exit condition: the target Raspberry Pi, macOS host, Linux host, and iPhone
topology works over administrator-provided LAN or VPN networking.

### Phase 10: Stabilize the client API

- Mark a versioned subset of contracts as the supported Cocoa client protocol.
- Separate internal reactor/provider messages from client-visible schemas.
- Publish a small TypeScript client package with connection, request, subscription,
  recovery, and capability helpers.
- Add compatibility tests so custom clients can evolve independently of the server.

Exit condition: a custom client can be built from the published contracts without
importing the reference web app or knowing the Codex protocol.

## Upstream intake strategy

Cocoa remains a selective downstream, not a permanently rebased distribution.
Preserve the practical ability to import useful T3 Code changes as follows:

- Keep upstream package names, generic contracts, command/event names, and client
  structure unless the target architecture requires a change. Avoid broad
  rebranding, file moves, or cosmetic rewrites in shared code.
- Put Cocoa-specific transport, endpoint, and remote-capability implementations in
  new focused modules. Touch high-churn upstream composition files only to inject
  those modules.
- Keep `ProviderDriver`, `ProviderInstanceRegistry`, `ProviderService`, the pure
  decider/projector, and normalized Codex event mapping as the primary seams.
- Never hand-edit generated Codex protocol files. Import or regenerate protocol
  updates as isolated atomic changes, then adapt Cocoa in a following commit.
- Mark reviewed upstream horizons with immutable tags. For each wanted feature,
  create a dated intake branch, cherry-pick the upstream squash commit with `-x`,
  and place Cocoa-specific conflict adaptation in a separate commit.
- Classify every upstream window as imported, skipped, or deferred. Usually skip
  hosted T3 auth/relay/fleet changes, new local-provider spawning, and parity work
  for unsupported providers.
- Keep initial disposable-database schema cutovers simple. Once Cocoa persistence
  stabilizes, use a Cocoa-owned migration chain/table so future upstream migration
  numbers cannot collide with fork-only migrations.
- Periodically run a disposable merge-conflict forecast against upstream `main`;
  never merge that forecast branch.

## Target acceptance test

The initial fork direction is complete when all of the following work together:

- An ARM64 Raspberry Pi runs the Cocoa gateway, web assets, and SQLite in a
  container with no Codex binary, Git binary, Codex account credentials, or
  workspace mount. It contains only the configured endpoint transport and its
  connection credentials.
- The gateway connects through SSH proxy to the independently managed standalone
  Codex daemons on the macOS and Linux provider hosts; neither daemon is restarted
  or reconfigured by Cocoa.
- An iPhone connects to the gateway, lists remote directories, creates and resumes
  a thread, streams activity, answers approvals, and inspects a remote diff.
- A turn continues while the phone is disconnected.
- A temporary gateway-to-Codex interruption converges without duplicates for the
  documented recoverable state and exposes any non-recoverable activity gap.
- No local provider CLI spawning or local project operation is exercised by the
  gateway.

## Non-goals for the first fork

- A general-purpose agent runner protocol
- Feature parity across providers
- Direct client-to-provider connections
- Tunnels, relays, hosted identity, or cloud fleet management
- Automatic LAN/VPN/TLS/reverse-proxy configuration
- Multi-replica gateway operation or high availability
- Making ephemeral terminals survive every daemon or gateway restart
- Rebuilding upstream orchestration or clients solely for architectural purity
- A public documentation or community-contribution program

## Guiding constraints

- Preserve upstream code when it already fits the new boundary.
- Prefer an adapter beneath existing behavior over a cross-cutting rewrite.
- Make remote location explicit in identity and types; never hide it behind a
  local-looking path abstraction.
- Keep provider-native and experimental APIs quarantined at the Codex boundary.
- Add a capability only after its end-to-end remote ownership is clear.
- The gateway is the durable authority for normalized client state; the provider
  host is the authority for workspace and native provider state.

// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import type {
  CocoaHostControlErrorResponse,
  CocoaHostVcsRequest,
  CocoaHostVcsResponse,
  VcsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  controlError,
  hasCurrentGeneration,
  HOST_CONTROL_MAX_REPOSITORY_HANDLES,
  setBoundedHandle,
  type HostControlOperationDependencies,
  type HostControlOperationState,
  type HostControlRepositoryHandle,
} from "./state.ts";

export type VcsControlResult = CocoaHostVcsResponse | CocoaHostControlErrorResponse;

const OPEN_OUTPUT_BYTES = 64 * 1024;
const STATUS_OUTPUT_BYTES = 4 * 1024 * 1024;
const LIST_OUTPUT_BYTES = 4 * 1024 * 1024;
const MUTATION_OUTPUT_BYTES = 4 * 1024 * 1024;
const PREPARE_SUMMARY_OUTPUT_BYTES = 512 * 1024;
const PREPARE_PATCH_OUTPUT_BYTES = 3 * 1024 * 1024;
export const HOST_CONTROL_SAFE_WIRE_PATCH_BYTES = 4 * 1024 * 1024 - 64 * 1024;
const MUTATION_TIMEOUT_MS = 2 * 60_000;
const MAX_UNTRACKED_DIFF_FILES = 1_000;

const responseBase = <O extends CocoaHostVcsRequest["operation"]>(
  request: CocoaHostVcsRequest,
  operation: O,
) => ({
  protocolVersion: request.protocolVersion,
  requestId: request.requestId,
  operation,
});

const isMutation = (operation: CocoaHostVcsRequest["operation"]): boolean =>
  operation === "vcs.pull" ||
  operation === "vcs.createWorktree" ||
  operation === "vcs.removeWorktree" ||
  operation === "vcs.createRef" ||
  operation === "vcs.switchRef" ||
  operation === "vcs.prepareCommit" ||
  operation === "vcs.commit" ||
  operation === "vcs.push";

const vcsControlError = (
  request: CocoaHostVcsRequest,
  error: VcsError,
): CocoaHostControlErrorResponse => {
  if (error._tag === "VcsProcessOutputLimitError") {
    return controlError(request, "limitExceeded", "VCS output exceeded the requested limit.");
  }
  if (
    isMutation(request.operation) &&
    (error._tag === "VcsProcessTimeoutError" ||
      error._tag === "VcsProcessOutputReadError" ||
      error._tag === "VcsProcessMissingExitCodeError")
  ) {
    return controlError(
      request,
      "outcomeUnknown",
      "The VCS mutation was dispatched but its outcome could not be established.",
    );
  }
  return controlError(
    request,
    "operationFailed",
    "The normalized VCS operation failed on the host.",
    error._tag === "VcsProcessTimeoutError" && !isMutation(request.operation),
  );
};

const runGit = (
  state: HostControlOperationState,
  dependencies: Pick<HostControlOperationDependencies, "runVcs">,
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly allowNonZeroExit?: boolean;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  },
) =>
  dependencies.runVcs({
    operation,
    command: state.gitExecutable,
    args: ["-C", cwd, ...args],
    cwd,
    spawnCwd: globalThis.process.cwd(),
    ...(options?.allowNonZeroExit === undefined
      ? {}
      : { allowNonZeroExit: options.allowNonZeroExit }),
    ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options?.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
  });

const resolveRepository = (
  state: HostControlOperationState,
  request: Exclude<CocoaHostVcsRequest, { readonly operation: "vcs.open" }>,
): HostControlRepositoryHandle | CocoaHostControlErrorResponse => {
  if (!hasCurrentGeneration(state, request)) {
    return controlError(request, "staleHandle", "VCS handle belongs to a stale host generation.");
  }
  return (
    state.repositories.get(request.repositoryId) ??
    controlError(request, "notFound", "VCS repository handle was not found on this host.")
  );
};

const changedKind = (xy: string) => {
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "conflicted" as const;
  if (xy.includes("R")) return "renamed" as const;
  if (xy.includes("C")) return "copied" as const;
  if (xy.includes("A")) return "added" as const;
  if (xy.includes("D")) return "deleted" as const;
  return "modified" as const;
};

const parseStatus = (output: string, maxChangedPaths: number) => {
  const records = output.split("\0");
  let oid: string | null = null;
  let branch: string | null = null;
  let upstreamRef: string | null = null;
  let aheadCount = 0;
  let behindCount = 0;
  const changedPaths: Array<{
    path: string;
    previousPath?: string;
    kind: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted";
    staged: boolean;
    unstaged: boolean;
    additions: null;
    deletions: null;
  }> = [];
  let omitted = false;

  const append = (entry: (typeof changedPaths)[number]) => {
    if (changedPaths.length >= maxChangedPaths) omitted = true;
    else changedPaths.push(entry);
  };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.startsWith("# branch.oid ")) {
      const value = record.slice("# branch.oid ".length);
      oid = value === "(initial)" ? null : value;
      continue;
    }
    if (record.startsWith("# branch.head ")) {
      const value = record.slice("# branch.head ".length);
      branch = value === "(detached)" ? null : value;
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      upstreamRef = record.slice("# branch.upstream ".length) || null;
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+([0-9]+) -([0-9]+)$/u.exec(record);
      aheadCount = Number(match?.[1] ?? 0);
      behindCount = Number(match?.[2] ?? 0);
      continue;
    }
    if (record.startsWith("? ")) {
      append({
        path: record.slice(2),
        kind: "untracked",
        staged: false,
        unstaged: true,
        additions: null,
        deletions: null,
      });
      continue;
    }
    const ordinary = /^1 ([^ ]{2}) (?:[^ ]+ ){6}(.*)$/u.exec(record);
    if (ordinary) {
      const xy = ordinary[1]!;
      append({
        path: ordinary[2]!,
        kind: changedKind(xy),
        staged: xy[0] !== ".",
        unstaged: xy[1] !== ".",
        additions: null,
        deletions: null,
      });
      continue;
    }
    const renamed = /^2 ([^ ]{2}) (?:[^ ]+ ){7}(.*)$/u.exec(record);
    if (renamed) {
      const xy = renamed[1]!;
      const previousPath = records[index + 1];
      index += 1;
      append({
        path: renamed[2]!,
        ...(previousPath === undefined ? {} : { previousPath }),
        kind: changedKind(xy),
        staged: xy[0] !== ".",
        unstaged: xy[1] !== ".",
        additions: null,
        deletions: null,
      });
      continue;
    }
    const unmerged = /^u ([^ ]{2}) (?:[^ ]+ ){8}(.*)$/u.exec(record);
    if (unmerged) {
      const xy = unmerged[1]!;
      append({
        path: unmerged[2]!,
        kind: "conflicted",
        staged: xy[0] !== ".",
        unstaged: xy[1] !== ".",
        additions: null,
        deletions: null,
      });
    }
  }
  return {
    oid,
    branch,
    upstreamRef,
    aheadCount,
    behindCount,
    changedPaths,
    truncated: omitted,
  };
};

const redactRemoteUrl = (value: string): string => {
  try {
    const parsed = new URL(value);
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      parsed.username = "";
      parsed.password = "";
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const withoutQuery = value.replace(/[?#].*$/u, "");
    const scpLike = /^[^@/\s]+@(.+)$/u.exec(withoutQuery);
    return scpLike?.[1] ?? withoutQuery;
  }
};

const parseRemotes = (output: string) => {
  const remotes = new Map<string, { fetchUrl?: string; pushUrl?: string }>();
  for (const line of output.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/u.exec(line.trim());
    if (!match) continue;
    const name = match[1]!;
    const remote = remotes.get(name) ?? {};
    if (match[3] === "fetch") remote.fetchUrl = redactRemoteUrl(match[2]!);
    else remote.pushUrl = redactRemoteUrl(match[2]!);
    remotes.set(name, remote);
  }
  return remotes;
};

const resolveDefaultRef = (
  state: HostControlOperationState,
  dependencies: Pick<HostControlOperationDependencies, "runVcs">,
  repository: HostControlRepositoryHandle,
) =>
  runGit(
    state,
    dependencies,
    "hostControl.vcs.defaultRef",
    repository.rootPath,
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { allowNonZeroExit: true, maxOutputBytes: OPEN_OUTPUT_BYTES },
  ).pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() || null : null)));

const validRefName = (
  state: HostControlOperationState,
  dependencies: Pick<HostControlOperationDependencies, "runVcs">,
  repository: HostControlRepositoryHandle,
  refName: string,
) => {
  if (refName.startsWith("-") || refName.includes("\0")) return Effect.succeed(false);
  return runGit(
    state,
    dependencies,
    "hostControl.vcs.validateRef",
    repository.rootPath,
    ["check-ref-format", "--branch", refName],
    { allowNonZeroExit: true, maxOutputBytes: OPEN_OUTPUT_BYTES },
  ).pipe(Effect.map((result) => result.exitCode === 0));
};

const invalidRef = (request: CocoaHostVcsRequest) =>
  controlError(request, "invalidRequest", "VCS ref name was rejected by the host.");

const normalizedMutation = (
  state: HostControlOperationState,
  dependencies: Pick<HostControlOperationDependencies, "runVcs">,
  request: CocoaHostVcsRequest,
  repository: HostControlRepositoryHandle,
  args: ReadonlyArray<string>,
) =>
  runGit(state, dependencies, `hostControl.${request.operation}`, repository.rootPath, args, {
    timeoutMs: MUTATION_TIMEOUT_MS,
    maxOutputBytes: MUTATION_OUTPUT_BYTES,
  });

const automaticBase = Effect.fn("HostControl.vcs.automaticBase")(function* (
  state: HostControlOperationState,
  dependencies: Pick<HostControlOperationDependencies, "runVcs">,
  repository: HostControlRepositoryHandle,
) {
  for (const candidate of [
    "@{upstream}",
    yield* resolveDefaultRef(state, dependencies, repository),
    "HEAD^",
  ] as const) {
    if (candidate === null) continue;
    const verified = yield* runGit(
      state,
      dependencies,
      "hostControl.vcs.resolveBase",
      repository.rootPath,
      ["rev-parse", "--verify", candidate],
      { allowNonZeroExit: true, maxOutputBytes: OPEN_OUTPUT_BYTES },
    );
    if (verified.exitCode === 0) return candidate;
  }
  return "HEAD";
});

export const makeVcsControlHandler = (
  state: HostControlOperationState,
  dependencies: Pick<HostControlOperationDependencies, "runVcs">,
) =>
  Effect.fn("HostControl.vcs")(function* (
    request: CocoaHostVcsRequest,
  ): Effect.fn.Return<VcsControlResult> {
    if (request.operation === "vcs.open") {
      return yield* Effect.gen(function* () {
        const detected = yield* runGit(
          state,
          dependencies,
          "hostControl.vcs.open.detect",
          request.path,
          ["rev-parse", "--is-inside-work-tree"],
          { allowNonZeroExit: true, maxOutputBytes: OPEN_OUTPUT_BYTES },
        );
        if (detected.exitCode !== 0 || detected.stdout.trim() !== "true") {
          return {
            ...responseBase(request, "vcs.open"),
            result: { kind: "notRepository" as const },
          };
        }
        const root = yield* runGit(
          state,
          dependencies,
          "hostControl.vcs.open.root",
          request.path,
          ["rev-parse", "--show-toplevel"],
          { maxOutputBytes: OPEN_OUTPUT_BYTES },
        );
        const common = yield* runGit(
          state,
          dependencies,
          "hostControl.vcs.open.commonDirectory",
          request.path,
          ["rev-parse", "--git-common-dir"],
          { allowNonZeroExit: true, maxOutputBytes: OPEN_OUTPUT_BYTES },
        );
        const rootPath = root.stdout.trim();
        const commonValue = common.exitCode === 0 ? common.stdout.trim() : "";
        const commonDirectoryPath =
          commonValue.length === 0
            ? null
            : NodePath.posix.isAbsolute(commonValue)
              ? NodePath.posix.normalize(commonValue)
              : NodePath.posix.resolve(rootPath, commonValue);
        const repositoryId = state.makeResourceId();
        setBoundedHandle(
          state.repositories,
          repositoryId,
          { rootPath, commonDirectoryPath },
          HOST_CONTROL_MAX_REPOSITORY_HANDLES,
        );
        return {
          ...responseBase(request, "vcs.open"),
          result: {
            kind: "repository" as const,
            generationId: state.generationId,
            repositoryId,
            driverKind: "git" as const,
            rootPath,
            commonDirectoryPath,
            operations: [
              "open",
              "status",
              "listRefs",
              "listRemotes",
              "pull",
              "createWorktree",
              "removeWorktree",
              "createRef",
              "switchRef",
              "prepareCommit",
              "commit",
              "push",
            ] as const,
            reviewDiff: true,
          },
        };
      }).pipe(Effect.catch((error: VcsError) => Effect.succeed(vcsControlError(request, error))));
    }

    const repository = resolveRepository(state, request);
    if ("error" in repository) return repository;

    let completedMutation = false;
    const mutate = (args: ReadonlyArray<string>) =>
      normalizedMutation(state, dependencies, request, repository, args).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            completedMutation = true;
          }),
        ),
      );

    const operation = Effect.gen(function* () {
      switch (request.operation) {
        case "vcs.status": {
          const result = yield* runGit(
            state,
            dependencies,
            "hostControl.vcs.status",
            repository.rootPath,
            ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
            { maxOutputBytes: STATUS_OUTPUT_BYTES },
          );
          const status = parseStatus(result.stdout, request.maxChangedPaths);
          const defaultRef = yield* resolveDefaultRef(state, dependencies, repository);
          const primaryRemote = yield* runGit(
            state,
            dependencies,
            "hostControl.vcs.primaryRemote",
            repository.rootPath,
            ["remote", "get-url", "origin"],
            { allowNonZeroExit: true, maxOutputBytes: OPEN_OUTPUT_BYTES },
          );
          return {
            ...responseBase(request, "vcs.status"),
            head:
              status.oid === null
                ? ({ kind: "unborn" } as const)
                : status.branch === null
                  ? ({ kind: "detached", commit: status.oid } as const)
                  : ({ kind: "branch", name: status.branch, commit: status.oid } as const),
            defaultRef,
            upstreamRef: status.upstreamRef,
            aheadCount: status.aheadCount,
            behindCount: status.behindCount,
            hasPrimaryRemote: primaryRemote.exitCode === 0,
            hasWorkingTreeChanges: status.changedPaths.length > 0 || status.truncated,
            changedPaths: status.changedPaths,
            truncated: status.truncated || result.stdoutTruncated,
          };
        }
        case "vcs.listRefs": {
          const prefixes =
            request.scope === "local"
              ? ["refs/heads"]
              : request.scope === "knownRemote"
                ? ["refs/remotes"]
                : ["refs/heads", "refs/remotes"];
          const result = yield* runGit(
            state,
            dependencies,
            "hostControl.vcs.listRefs",
            repository.rootPath,
            [
              "for-each-ref",
              "--format=%(refname)%00%(objectname)%00%(HEAD)%00%(worktreepath)",
              ...prefixes,
            ],
            { maxOutputBytes: LIST_OUTPUT_BYTES },
          );
          const defaultRef = yield* resolveDefaultRef(state, dependencies, repository);
          const query = request.query?.toLocaleLowerCase();
          const refs: Array<{
            kind: "local" | "knownRemote";
            name: string;
            target: string;
            current: boolean;
            isDefault: boolean;
            worktreePath: string | null;
          }> = [];
          let omitted = false;
          for (const line of result.stdout.split("\n")) {
            if (line.length === 0) continue;
            const [fullName, target, head, worktreePath = ""] = line.split("\0");
            if (!fullName || !target) continue;
            const local = fullName.startsWith("refs/heads/");
            const name = local
              ? fullName.slice("refs/heads/".length)
              : fullName.startsWith("refs/remotes/")
                ? fullName.slice("refs/remotes/".length)
                : fullName;
            if (
              (!local && name.endsWith("/HEAD")) ||
              (query && !name.toLocaleLowerCase().includes(query))
            ) {
              continue;
            }
            if (refs.length >= request.maxRefs) {
              omitted = true;
              continue;
            }
            refs.push({
              kind: local ? "local" : "knownRemote",
              name,
              target,
              current: head === "*",
              isDefault: defaultRef === name,
              worktreePath: worktreePath || null,
            });
          }
          return {
            ...responseBase(request, "vcs.listRefs"),
            refs,
            truncated: omitted || result.stdoutTruncated,
          };
        }
        case "vcs.listRemotes": {
          const result = yield* runGit(
            state,
            dependencies,
            "hostControl.vcs.listRemotes",
            repository.rootPath,
            ["remote", "-v"],
            { maxOutputBytes: LIST_OUTPUT_BYTES },
          );
          const parsed = parseRemotes(result.stdout);
          const remotes = [...parsed.entries()]
            .filter((entry): entry is [string, { fetchUrl: string; pushUrl?: string }] =>
              Boolean(entry[1].fetchUrl),
            )
            .sort(([left], [right]) => left.localeCompare(right));
          return {
            ...responseBase(request, "vcs.listRemotes"),
            remotes: remotes.slice(0, request.maxRemotes).map(([name, remote]) => ({
              name,
              fetchUrl: remote.fetchUrl,
              pushUrl: remote.pushUrl === undefined ? null : remote.pushUrl,
              isPrimary: name === "origin",
            })),
            truncated: remotes.length > request.maxRemotes || result.stdoutTruncated,
          };
        }
        case "vcs.diff": {
          const patchLimit = Math.min(request.maxBytes, HOST_CONTROL_SAFE_WIRE_PATCH_BYTES);
          const baseRef =
            request.source === "baseRange"
              ? request.baseRef === "automatic"
                ? yield* automaticBase(state, dependencies, repository)
                : request.baseRef
              : null;
          const whitespace = request.ignoreWhitespace ? ["--ignore-all-space"] : [];
          const args =
            request.source === "baseRange"
              ? [
                  "diff",
                  "--patch",
                  "--no-color",
                  "--no-ext-diff",
                  "--no-textconv",
                  ...whitespace,
                  `${baseRef}...HEAD`,
                  "--",
                ]
              : [
                  "diff",
                  "--patch",
                  "--no-color",
                  "--no-ext-diff",
                  "--no-textconv",
                  ...whitespace,
                  "HEAD",
                  "--",
                ];
          const result = yield* runGit(
            state,
            dependencies,
            "hostControl.vcs.diff",
            repository.rootPath,
            args,
            { maxOutputBytes: patchLimit },
          );
          let patch = result.stdout;
          let truncated = result.stdoutTruncated;
          if (request.source === "workingTree" && !truncated) {
            const untracked = yield* runGit(
              state,
              dependencies,
              "hostControl.vcs.diff.untracked",
              repository.rootPath,
              ["ls-files", "--others", "--exclude-standard", "-z"],
              { maxOutputBytes: LIST_OUTPUT_BYTES },
            );
            const paths = untracked.stdout.split("\0").filter((path) => path.length > 0);
            truncated ||= untracked.stdoutTruncated || paths.length > MAX_UNTRACKED_DIFF_FILES;
            for (const path of paths.slice(0, MAX_UNTRACKED_DIFF_FILES)) {
              const remaining = patchLimit - Buffer.byteLength(patch, "utf8");
              if (remaining <= 0) {
                truncated = true;
                break;
              }
              const fileDiff = yield* runGit(
                state,
                dependencies,
                "hostControl.vcs.diff.untrackedFile",
                repository.rootPath,
                [
                  "diff",
                  "--no-index",
                  "--patch",
                  "--binary",
                  "--no-color",
                  "--no-ext-diff",
                  "--no-textconv",
                  ...whitespace,
                  "--",
                  "/dev/null",
                  path,
                ],
                { allowNonZeroExit: true, maxOutputBytes: remaining },
              );
              if (fileDiff.exitCode !== 0 && fileDiff.exitCode !== 1) {
                return controlError(
                  request,
                  "operationFailed",
                  "The host could not render an untracked-file diff.",
                );
              }
              patch += fileDiff.stdout;
              truncated ||= fileDiff.stdoutTruncated;
              if (fileDiff.stdoutTruncated) break;
            }
          }
          return {
            ...responseBase(request, "vcs.diff"),
            source: request.source,
            baseRef,
            headRef: "HEAD",
            patch,
            byteLength: Buffer.byteLength(patch, "utf8"),
            truncated,
          };
        }
        case "vcs.pull": {
          const branch = yield* runGit(
            state,
            dependencies,
            "hostControl.vcs.pull.branch",
            repository.rootPath,
            ["branch", "--show-current"],
            { maxOutputBytes: OPEN_OUTPUT_BYTES },
          );
          const refName = branch.stdout.trim();
          if (refName.length === 0) return invalidRef(request);
          const upstream = yield* runGit(
            state,
            dependencies,
            "hostControl.vcs.pull.upstream",
            repository.rootPath,
            ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
            { allowNonZeroExit: true, maxOutputBytes: OPEN_OUTPUT_BYTES },
          );
          const before = yield* runGit(
            state,
            dependencies,
            "hostControl.vcs.pull.before",
            repository.rootPath,
            ["rev-parse", "HEAD"],
            { maxOutputBytes: OPEN_OUTPUT_BYTES },
          );
          yield* mutate(["pull", "--ff-only"]);
          const after = yield* runGit(
            state,
            dependencies,
            "hostControl.vcs.pull.after",
            repository.rootPath,
            ["rev-parse", "HEAD"],
            { maxOutputBytes: OPEN_OUTPUT_BYTES },
          );
          return {
            ...responseBase(request, "vcs.pull"),
            status:
              before.stdout.trim() === after.stdout.trim()
                ? ("skipped_up_to_date" as const)
                : ("pulled" as const),
            refName,
            upstreamRef: upstream.exitCode === 0 ? upstream.stdout.trim() || null : null,
          };
        }
        case "vcs.createWorktree": {
          const names = [request.refName, request.newRefName, request.baseRefName].filter(
            (name): name is string => name !== undefined,
          );
          for (const name of names) {
            if (!(yield* validRefName(state, dependencies, repository, name))) {
              return invalidRef(request);
            }
          }
          const selectedRef = request.baseRefName ?? request.refName;
          const path =
            request.path ??
            NodePath.posix.join(
              NodePath.posix.dirname(repository.rootPath),
              `${NodePath.posix.basename(repository.rootPath)}-${(request.newRefName ?? request.refName).replaceAll("/", "-")}-${state.makeResourceId()}`,
            );
          const args =
            request.newRefName === undefined
              ? ["worktree", "add", "--", path, selectedRef]
              : ["worktree", "add", "-b", request.newRefName, "--", path, selectedRef];
          yield* mutate(args);
          return {
            ...responseBase(request, "vcs.createWorktree"),
            path,
            refName: request.newRefName ?? request.refName,
          };
        }
        case "vcs.removeWorktree":
          yield* mutate([
            "worktree",
            "remove",
            ...(request.force ? ["--force"] : []),
            "--",
            request.path,
          ]);
          return responseBase(request, "vcs.removeWorktree");
        case "vcs.createRef":
          if (!(yield* validRefName(state, dependencies, repository, request.refName))) {
            return invalidRef(request);
          }
          yield* mutate(
            request.switchRef ? ["switch", "-c", request.refName] : ["branch", request.refName],
          );
          return { ...responseBase(request, "vcs.createRef"), refName: request.refName };
        case "vcs.switchRef": {
          if (!(yield* validRefName(state, dependencies, repository, request.refName))) {
            return invalidRef(request);
          }
          yield* mutate(["switch", "--", request.refName]);
          const branch = yield* runGit(
            state,
            dependencies,
            "hostControl.vcs.switchRef.current",
            repository.rootPath,
            ["branch", "--show-current"],
            { maxOutputBytes: OPEN_OUTPUT_BYTES },
          );
          return {
            ...responseBase(request, "vcs.switchRef"),
            refName: branch.stdout.trim() || null,
          };
        }
        case "vcs.prepareCommit": {
          if (request.filePaths !== undefined && request.filePaths.length > 0) {
            yield* mutate(["reset"]);
            yield* mutate(["--literal-pathspecs", "add", "-A", "--", ...request.filePaths]);
          } else {
            yield* mutate(["add", "-A"]);
          }
          const summary = yield* runGit(
            state,
            dependencies,
            "hostControl.vcs.prepareCommit.summary",
            repository.rootPath,
            ["diff", "--cached", "--name-status"],
            { maxOutputBytes: PREPARE_SUMMARY_OUTPUT_BYTES },
          );
          if (summary.stdout.trim().length === 0) {
            return { ...responseBase(request, "vcs.prepareCommit"), prepared: null };
          }
          const patch = yield* runGit(
            state,
            dependencies,
            "hostControl.vcs.prepareCommit.patch",
            repository.rootPath,
            ["diff", "--no-ext-diff", "--cached", "--patch", "--minimal"],
            { maxOutputBytes: PREPARE_PATCH_OUTPUT_BYTES },
          );
          const branch = yield* runGit(
            state,
            dependencies,
            "hostControl.vcs.prepareCommit.branch",
            repository.rootPath,
            ["branch", "--show-current"],
            { maxOutputBytes: OPEN_OUTPUT_BYTES },
          );
          return {
            ...responseBase(request, "vcs.prepareCommit"),
            prepared: {
              branch: branch.stdout.trim() || null,
              stagedSummary: summary.stdout.trim(),
              stagedPatch: patch.stdout,
            },
          };
        }
        case "vcs.commit": {
          const args = ["commit", "-m", request.subject];
          if (request.body.trim().length > 0) args.push("-m", request.body.trim());
          yield* mutate(args);
          const head = yield* runGit(
            state,
            dependencies,
            "hostControl.vcs.commit.head",
            repository.rootPath,
            ["rev-parse", "HEAD"],
            { maxOutputBytes: OPEN_OUTPUT_BYTES },
          );
          return { ...responseBase(request, "vcs.commit"), commitSha: head.stdout.trim() };
        }
        case "vcs.push": {
          const branch = yield* runGit(
            state,
            dependencies,
            "hostControl.vcs.push.branch",
            repository.rootPath,
            ["branch", "--show-current"],
            { maxOutputBytes: OPEN_OUTPUT_BYTES },
          );
          const branchName = branch.stdout.trim();
          if (branchName.length === 0) return invalidRef(request);
          const upstream = yield* runGit(
            state,
            dependencies,
            "hostControl.vcs.push.upstream",
            repository.rootPath,
            ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
            { allowNonZeroExit: true, maxOutputBytes: OPEN_OUTPUT_BYTES },
          );
          const upstreamBranch = upstream.exitCode === 0 ? upstream.stdout.trim() : "";
          if (upstreamBranch.length > 0) {
            const ahead = yield* runGit(
              state,
              dependencies,
              "hostControl.vcs.push.ahead",
              repository.rootPath,
              ["rev-list", "--count", `${upstreamBranch}..HEAD`],
              { maxOutputBytes: OPEN_OUTPUT_BYTES },
            );
            if (Number.parseInt(ahead.stdout.trim(), 10) === 0) {
              return {
                ...responseBase(request, "vcs.push"),
                status: "skipped_up_to_date" as const,
                branch: branchName,
                upstreamBranch,
              };
            }
            yield* mutate(["push"]);
            return {
              ...responseBase(request, "vcs.push"),
              status: "pushed" as const,
              branch: branchName,
              upstreamBranch,
              setUpstream: false,
            };
          }
          const origin = yield* runGit(
            state,
            dependencies,
            "hostControl.vcs.push.origin",
            repository.rootPath,
            ["remote", "get-url", "origin"],
            { allowNonZeroExit: true, maxOutputBytes: OPEN_OUTPUT_BYTES },
          );
          if (origin.exitCode !== 0) {
            return controlError(request, "operationFailed", "No upstream or origin remote exists.");
          }
          yield* mutate(["push", "--set-upstream", "origin", "HEAD"]);
          return {
            ...responseBase(request, "vcs.push"),
            status: "pushed" as const,
            branch: branchName,
            upstreamBranch: `origin/${branchName}`,
            setUpstream: true,
          };
        }
      }
    });
    return yield* operation.pipe(
      Effect.catch((error: VcsError) =>
        Effect.succeed(
          completedMutation
            ? controlError(
                request,
                "outcomeUnknown",
                "A VCS mutation completed, but its final result could not be established.",
              )
            : vcsControlError(request, error),
        ),
      ),
    );
  });

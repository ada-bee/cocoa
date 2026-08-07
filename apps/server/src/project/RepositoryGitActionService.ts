/** Provider-routed commit/push workflows keyed by durable project identity. */
import {
  GitCommandError,
  GitManagerError,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type ModelSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderVcsRefLimit } from "../provider/ProviderVcsAdapter.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  conventionalCommitsTextGenerationPolicy,
  customTextGenerationPolicy,
  repositoryConventionsTextGenerationPolicy,
} from "../textGeneration/TextGenerationPresets.ts";
import * as ProjectRepository from "./ProjectRepository.ts";

type ProgressPublisher = (event: GitActionProgressEvent) => Effect.Effect<void, never>;

export interface RepositoryGitActionServiceShape {
  readonly run: (
    input: GitRunStackedActionInput,
    publish: ProgressPublisher,
  ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
}

export class RepositoryGitActionService extends Context.Service<
  RepositoryGitActionService,
  RepositoryGitActionServiceShape
>()("t3/project/RepositoryGitActionService") {}

const managerError = (input: GitRunStackedActionInput, detail: string) =>
  new GitManagerError({ operation: "git.runStackedAction", cwd: input.cwd, detail });

const commandError = (input: GitRunStackedActionInput, operation: string, detail: string) =>
  new GitCommandError({ operation, command: "git", cwd: input.cwd, detail });

const parseCommitMessage = (value: string) => {
  const [firstLine, ...rest] = value.replace(/\r\n/g, "\n").trim().split("\n");
  const subject = (firstLine ?? "").trim().replace(/[.]+$/g, "").slice(0, 72).trimEnd();
  return subject.length === 0 ? null : { subject, body: rest.join("\n").trim() };
};

const sanitizeBranch = (value: string): string => {
  const fragment = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-./]+|[-./]+$/g, "")
    .slice(0, 80);
  return `cocoa/${fragment || "update"}`;
};

export const make = Effect.gen(function* () {
  const projects = yield* ProjectRepository.ProjectRepository;
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const resolveProviderInstanceId = Effect.fn("RepositoryGitActionService.resolveProvider")(
    function* (input: GitRunStackedActionInput) {
      if (input.target === undefined) {
        return yield* managerError(input, "A durable project target is required for Git actions.");
      }
      const project = yield* projection.getProjectShellById(input.target.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError(() =>
          managerError(input, "The provider-host project could not be resolved."),
        ),
      );
      if (project === undefined) {
        return yield* managerError(input, "The provider-host project could not be resolved.");
      }
      return project.providerInstanceId;
    },
  );

  const resolveTextSettings = Effect.fn("RepositoryGitActionService.resolveTextSettings")(
    function* (providerInstanceId: ProviderInstanceId, input: GitRunStackedActionInput) {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(() => managerError(input, "Source-control settings could not be read.")),
      );
      const perProvider = settings.textGenerationModelSelections?.[providerInstanceId];
      const fallback = settings.textGenerationModelSelection;
      const modelSelection: ModelSelection | undefined =
        perProvider ?? (fallback.instanceId === providerInstanceId ? fallback : undefined);
      if (modelSelection === undefined) {
        return yield* managerError(
          input,
          "Configure a text-generation model for this provider host before committing.",
        );
      }
      const style = settings.sourceControlWritingStyle;
      const policy =
        style.mode === "conventional_commits"
          ? conventionalCommitsTextGenerationPolicy
          : style.mode === "custom"
            ? customTextGenerationPolicy(
                style.customInstructions
                  ? {
                      commitInstructions: style.customInstructions,
                      changeRequestInstructions: style.customInstructions,
                    }
                  : {},
              )
            : style.mode === "repo_conventions"
              ? repositoryConventionsTextGenerationPolicy
              : undefined;
      return { modelSelection, policy };
    },
  );

  const run: RepositoryGitActionServiceShape["run"] = Effect.fn("RepositoryGitActionService.run")(
    function* (input, publish) {
      if (input.action === "create_pr" || input.action === "commit_push_pr") {
        return yield* managerError(
          input,
          "Change-request creation requires a source-control integration on the provider host.",
        );
      }
      if (input.target === undefined) {
        return yield* managerError(input, "A durable project target is required for Git actions.");
      }
      if (input.featureBranch && input.action === "push") {
        return yield* managerError(
          input,
          "A feature branch can only be created as part of a commit action.",
        );
      }

      const repository = yield* projects
        .resolve({
          projectId: input.target.projectId,
          ...(input.target.threadId === undefined ? {} : { threadId: input.target.threadId }),
        })
        .pipe(
          Effect.mapError(() =>
            managerError(input, "The provider-host repository could not be resolved."),
          ),
        );
      const wantsCommit = input.action === "commit" || input.action === "commit_push";
      const wantsPush = input.action === "push" || input.action === "commit_push";
      yield* publish({
        actionId: input.actionId,
        cwd: input.cwd,
        action: input.action,
        kind: "action_started",
        phases: [
          ...(input.featureBranch ? (["branch"] as const) : []),
          ...(wantsCommit ? (["commit"] as const) : []),
          ...(wantsPush ? (["push"] as const) : []),
        ],
      });

      let branch: GitRunStackedActionResult["branch"] = { status: "skipped_not_requested" };
      let commit: GitRunStackedActionResult["commit"] = { status: "skipped_not_requested" };
      let push: GitRunStackedActionResult["push"] = { status: "skipped_not_requested" };

      if (wantsCommit) {
        if (repository.prepareCommit === undefined || repository.commit === undefined) {
          return yield* managerError(
            input,
            "This provider host does not support commit operations.",
          );
        }
        yield* publish({
          actionId: input.actionId,
          cwd: input.cwd,
          action: input.action,
          kind: "phase_started",
          phase: "commit",
          label: input.commitMessage ? "Preparing commit..." : "Generating commit message...",
        });
        const prepared = yield* repository
          .prepareCommit(input.filePaths === undefined ? {} : { filePaths: input.filePaths })
          .pipe(
            Effect.mapError(() =>
              commandError(
                input,
                "git.prepareCommit",
                "The provider host could not prepare this commit.",
              ),
            ),
          );
        if (prepared === null) {
          commit = { status: "skipped_no_changes" };
        } else {
          const custom = parseCommitMessage(input.commitMessage ?? "");
          const generated =
            custom ??
            (yield* resolveProviderInstanceId(input).pipe(
              Effect.flatMap((providerInstanceId) =>
                resolveTextSettings(providerInstanceId, input).pipe(
                  Effect.flatMap(({ modelSelection, policy }) =>
                    textGeneration.generateCommitMessage({
                      providerInstanceId,
                      cwd: repository.identity.rootPath,
                      branch: prepared.branch,
                      stagedSummary: prepared.stagedSummary.slice(0, 8_000),
                      stagedPatch: prepared.stagedPatch.slice(0, 50_000),
                      ...(input.featureBranch ? { includeBranch: true } : {}),
                      ...(policy === undefined ? {} : { policy }),
                      modelSelection,
                    }),
                  ),
                ),
              ),
              Effect.map((result) => ({
                subject:
                  result.subject.trim().replace(/[.]+$/g, "").slice(0, 72).trimEnd() ||
                  "Update project files",
                body: result.body.trim(),
                ...(result.branch === undefined ? {} : { branch: result.branch }),
              })),
            ));

          if (input.featureBranch) {
            if (repository.createRef === undefined) {
              return yield* managerError(
                input,
                "This provider host cannot create a feature branch.",
              );
            }
            yield* publish({
              actionId: input.actionId,
              cwd: input.cwd,
              action: input.action,
              kind: "phase_started",
              phase: "branch",
              label: "Preparing feature branch...",
            });
            const suggested =
              "branch" in generated && typeof generated.branch === "string"
                ? generated.branch
                : generated.subject;
            const preferredBranch = sanitizeBranch(suggested);
            const existing = yield* repository
              .listRefs({ scope: "local", maxRefs: ProviderVcsRefLimit.make(10_000) })
              .pipe(
                Effect.mapError(() =>
                  commandError(
                    input,
                    "git.listFeatureBranches",
                    "The provider host could not list existing branches.",
                  ),
                ),
              );
            const names = new Set(existing.refs.map((ref) => ref.name));
            let branchName = preferredBranch;
            for (let suffix = 2; names.has(branchName); suffix += 1) {
              branchName = `${preferredBranch}-${suffix}`;
            }
            yield* repository
              .createRef({ refName: branchName, switchRef: true })
              .pipe(
                Effect.mapError(() =>
                  commandError(
                    input,
                    "git.createFeatureBranch",
                    "The provider host could not create the feature branch.",
                  ),
                ),
              );
            branch = { status: "created", name: branchName };
          }

          yield* publish({
            actionId: input.actionId,
            cwd: input.cwd,
            action: input.action,
            kind: "phase_started",
            phase: "commit",
            label: "Committing...",
          });
          const created = yield* repository
            .commit(generated)
            .pipe(
              Effect.mapError(() =>
                commandError(input, "git.commit", "The provider host could not create the commit."),
              ),
            );
          commit = { status: "created", commitSha: created.commitSha, subject: generated.subject };
        }
      }

      if (wantsPush) {
        if (repository.push === undefined) {
          return yield* managerError(input, "This provider host does not support push operations.");
        }
        yield* publish({
          actionId: input.actionId,
          cwd: input.cwd,
          action: input.action,
          kind: "phase_started",
          phase: "push",
          label: "Pushing...",
        });
        const pushed = yield* repository
          .push()
          .pipe(
            Effect.mapError(() =>
              commandError(input, "git.push", "The provider host could not push this branch."),
            ),
          );
        push = {
          status: pushed.status,
          branch: pushed.branch,
          ...(pushed.upstreamBranch === undefined ? {} : { upstreamBranch: pushed.upstreamBranch }),
          ...(pushed.setUpstream === undefined ? {} : { setUpstream: pushed.setUpstream }),
        };
      }

      const result: GitRunStackedActionResult = {
        action: input.action,
        branch,
        commit,
        push,
        pr: { status: "skipped_not_requested" },
        toast:
          push.status === "pushed"
            ? {
                title: "Pushed changes",
                ...(commit.subject === undefined ? {} : { description: commit.subject }),
                cta: { kind: "none" },
              }
            : commit.status === "created"
              ? {
                  title: `Committed ${commit.commitSha?.slice(0, 7) ?? "changes"}`,
                  ...(commit.subject === undefined ? {} : { description: commit.subject }),
                  cta: { kind: "none" },
                }
              : { title: "Done", cta: { kind: "none" } },
      };
      yield* publish({
        actionId: input.actionId,
        cwd: input.cwd,
        action: input.action,
        kind: "action_finished",
        result,
      });
      return result;
    },
  );

  return RepositoryGitActionService.of({ run });
});

export const layer = Layer.effect(RepositoryGitActionService, make);

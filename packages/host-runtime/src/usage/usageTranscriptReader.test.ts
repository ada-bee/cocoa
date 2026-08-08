// @effect-diagnostics nodeBuiltinImport:off
import { afterEach, describe, expect, test } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DEFAULT_TRANSCRIPT_SCAN_LIMITS,
  listTranscriptFiles,
  readTranscriptRecords,
} from "./usageTranscriptReader.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

describe("bounded transcript filesystem reader", () => {
  test("returns a tagged, path-free directory listing failure", async () => {
    const result = await listTranscriptFiles("/definitely/missing/cocoa-transcripts", 0);
    expect(result.complete).toBe(false);
    expect(result.issueCount).toBe(1);
    expect(result.issues[0]?._tag).toBe("ListDirectoryFailed");
    expect(JSON.stringify(result.issues)).not.toContain("cocoa-transcripts");
  });

  test("returns a tagged file read failure", async () => {
    const result = await readTranscriptRecords("/definitely/missing/transcript.jsonl", "codex");
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.issue._tag).toBe("ReadFileFailed");
    expect(JSON.stringify(result)).not.toContain("transcript.jsonl");
  });

  test("bounds candidate files even when none can be selected", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cocoa-reader-"));
    temporaryDirectories.push(root);
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        NodeFSP.writeFile(NodePath.join(root, `${index}.jsonl`), "{}\n"),
      ),
    );
    const result = await listTranscriptFiles(root, Number.MAX_SAFE_INTEGER, {
      ...DEFAULT_TRANSCRIPT_SCAN_LIMITS,
      maxFiles: 2,
    });
    expect(result.complete).toBe(false);
    expect(result.candidateFiles).toBe(3);
    expect(result.issues).toContainEqual({ _tag: "ScanLimitReached", limit: "files" });
  });

  test("bounds total selected bytes", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cocoa-reader-"));
    temporaryDirectories.push(root);
    await NodeFSP.writeFile(NodePath.join(root, "a.jsonl"), "12345");
    await NodeFSP.writeFile(NodePath.join(root, "b.jsonl"), "67890");
    const result = await listTranscriptFiles(root, 0, {
      ...DEFAULT_TRANSCRIPT_SCAN_LIMITS,
      maxBytes: 5,
    });
    expect(result.files).toHaveLength(1);
    expect(result.complete).toBe(false);
    expect(result.issues).toContainEqual({ _tag: "ScanLimitReached", limit: "bytes" });
  });
});

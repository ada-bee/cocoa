import { describe, expect, it } from "vite-plus/test";

import { collectIncompleteUsageSources } from "./UsagePage";

describe("usage source diagnostics", () => {
  it("surfaces bounded partial and failed source messages while ignoring complete sources", () => {
    const diagnostics = collectIncompleteUsageSources([
      {
        label: "Gateway",
        summary: {
          sources: [
            {
              status: "ok",
              message: null,
              fingerprint: { hostId: "host", sourceId: "ok", label: "Complete" },
            },
            {
              status: "partial",
              message: "Transcript record limit reached.",
              fingerprint: { hostId: "host", sourceId: "partial", label: "Codex sessions" },
            },
            {
              status: "failed",
              message: "Transcript directory could not be inspected.",
              fingerprint: { hostId: "host", sourceId: "failed", label: "Codex archive" },
            },
          ],
        },
      },
    ]);

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map(({ status, message }) => ({ status, message }))).toEqual([
      { status: "partial", message: "Transcript record limit reached." },
      { status: "failed", message: "Transcript directory could not be inspected." },
    ]);
  });
});

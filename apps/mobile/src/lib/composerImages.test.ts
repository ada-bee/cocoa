import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES,
} from "@t3tools/contracts";

const files = new Map<string, { base64: string; deleted: boolean }>();
const picker = vi.hoisted(() => ({
  result: {
    canceled: true,
    assets: [],
  } as
    | { readonly canceled: true; readonly assets: ReadonlyArray<never> }
    | {
        readonly canceled: false;
        readonly assets: ReadonlyArray<{
          readonly base64: string;
          readonly fileName: string;
          readonly fileSize: number;
          readonly mimeType: string;
          readonly uri: string;
        }>;
      },
}));
const clipboard = vi.hoisted(() => ({
  hasImage: false,
  hasString: false,
  imageData: "data:image/png;base64,AAAA",
  text: "",
}));

vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: async () => picker.result,
}));

vi.mock("expo-clipboard", () => ({
  hasImageAsync: async () => clipboard.hasImage,
  getImageAsync: async () => ({ data: clipboard.imageData }),
  hasStringAsync: async () => clipboard.hasString,
  getStringAsync: async () => clipboard.text,
}));

vi.mock("expo-file-system", () => ({
  File: class {
    readonly uri: string;

    constructor(uri: string) {
      this.uri = uri;
    }

    get exists(): boolean {
      return files.has(this.uri) && files.get(this.uri)?.deleted === false;
    }

    async base64(): Promise<string> {
      const entry = files.get(this.uri);
      if (!entry || entry.deleted) {
        throw new Error("missing file");
      }
      return entry.base64;
    }

    delete(): void {
      const entry = files.get(this.uri);
      if (entry) {
        entry.deleted = true;
      }
    }
  },
}));

vi.mock("./uuid", () => ({
  uuidv4: () => "attachment-id",
}));

import {
  convertPastedImagesToAttachments,
  isOwnedPastedImageUri,
  pasteComposerClipboard,
  pickComposerImages,
  toUploadChatImageAttachments,
} from "./composerImages";

const AGGREGATE_LIMIT_ERROR = "Image attachments can encode to at most 8 MiB per message.";

describe("toUploadChatImageAttachments", () => {
  it("strips client draft id and previewUri for the startTurn wire shape", () => {
    expect(
      toUploadChatImageAttachments([
        {
          id: "client-draft-id",
          type: "image",
          name: "pasted-image.png",
          mimeType: "image/png",
          sizeBytes: 12,
          dataUrl: "data:image/png;base64,AA==",
          previewUri: "file:///tmp/preview.png",
        },
      ]),
    ).toEqual([
      {
        type: "image",
        name: "pasted-image.png",
        mimeType: "image/png",
        sizeBytes: 12,
        dataUrl: "data:image/png;base64,AA==",
      },
    ]);
  });
});

describe("native pasted image cleanup", () => {
  beforeEach(() => {
    files.clear();
  });

  it("recognizes only files created in the native composer paste directory", () => {
    expect(
      isOwnedPastedImageUri(
        "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/id.png",
      ),
    ).toBe(true);
    expect(isOwnedPastedImageUri("file:///private/var/mobile/photos/id.png")).toBe(false);
    expect(isOwnedPastedImageUri("https://example.com/t3-composer-paste/id.png")).toBe(false);
  });

  it("converts owned files to data-backed previews and deletes the source", async () => {
    const uri =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/id.png";
    files.set(uri, { base64: "aGVsbG8=", deleted: false });

    const result = await convertPastedImagesToAttachments({
      uris: [uri],
      existingAttachments: [],
    });

    expect(result).toEqual({
      images: [
        expect.objectContaining({
          dataUrl: "data:image/png;base64,aGVsbG8=",
          previewUri: "data:image/png;base64,aGVsbG8=",
        }),
      ],
      error: null,
    });
    expect(files.get(uri)?.deleted).toBe(true);
  });

  it("deletes rejected and overflow owned files without deleting user-owned files", async () => {
    const rejected =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/bad.png";
    const overflow =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/overflow.png";
    const userOwned = "file:///private/var/mobile/photos/library.png";
    files.set(rejected, { base64: "", deleted: false });
    files.set(overflow, { base64: "aGVsbG8=", deleted: false });
    files.set(userOwned, { base64: "aGVsbG8=", deleted: false });

    await convertPastedImagesToAttachments({
      uris: [rejected, overflow, userOwned],
      existingAttachments: Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1 }, () => ({
        dataUrl: "data:image/png;base64,AA==",
      })),
    });

    expect(files.get(rejected)?.deleted).toBe(true);
    expect(files.get(overflow)?.deleted).toBe(true);
    expect(files.get(userOwned)?.deleted).toBe(false);
  });

  it("enforces and reports the encoded aggregate limit for native pasted images", async () => {
    const uri =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/aggregate.png";
    files.set(uri, { base64: "AAAA", deleted: false });

    const result = await convertPastedImagesToAttachments({
      uris: [uri],
      existingAttachments: [
        { dataUrl: "x".repeat(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES - 1) },
      ],
    });

    expect(result).toEqual({ images: [], error: AGGREGATE_LIMIT_ERROR });
    expect(files.get(uri)?.deleted).toBe(true);
  });
});

describe("encoded aggregate attachment preflight", () => {
  beforeEach(() => {
    picker.result = { canceled: true, assets: [] };
    clipboard.hasImage = false;
    clipboard.hasString = false;
    clipboard.imageData = "data:image/png;base64,AAAA";
    clipboard.text = "";
  });

  it("rejects a picked image before returning an over-budget draft", async () => {
    picker.result = {
      canceled: false,
      assets: [
        {
          base64: "AAAA",
          fileName: "picked.png",
          fileSize: 3,
          mimeType: "image/png",
          uri: "file:///picked.png",
        },
      ],
    };

    const result = await pickComposerImages({
      existingAttachments: [
        { dataUrl: "x".repeat(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES - 1) },
      ],
    });

    expect(result).toEqual({ images: [], error: AGGREGATE_LIMIT_ERROR });
  });

  it("accepts a picked image at the exact encoded aggregate boundary", async () => {
    const candidateDataUrl = "data:image/png;base64,AAAA";
    picker.result = {
      canceled: false,
      assets: [
        {
          base64: "AAAA",
          fileName: "boundary.png",
          fileSize: 3,
          mimeType: "image/png",
          uri: "file:///boundary.png",
        },
      ],
    };

    const result = await pickComposerImages({
      existingAttachments: [
        {
          dataUrl: "x".repeat(
            PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES - candidateDataUrl.length,
          ),
        },
      ],
    });

    expect(result.error).toBeNull();
    expect(result.images).toEqual([expect.objectContaining({ dataUrl: candidateDataUrl })]);
  });

  it("rejects a clipboard image before returning an over-budget draft", async () => {
    clipboard.hasImage = true;

    const result = await pasteComposerClipboard({
      existingAttachments: [
        { dataUrl: "x".repeat(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_BYTES - 1) },
      ],
    });

    expect(result).toEqual({ images: [], text: null, error: AGGREGATE_LIMIT_ERROR });
  });
});

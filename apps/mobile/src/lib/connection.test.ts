import { describe, expect, it, vi } from "vite-plus/test";
import { authClientMetadata } from "./connection";

vi.mock("./runtime", () => ({
  runtime: {
    runPromise: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
  },
}));

describe("mobile remote connection records", () => {
  it("identifies mobile token exchanges for authorized-client presentation", () => {
    expect(authClientMetadata()).toEqual({
      label: "Cocoa Code Mobile",
      deviceType: "mobile",
      os: "iOS",
    });
  });
});

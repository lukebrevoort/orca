import { describe, expect, it } from "bun:test";
import { toLegacyColors } from "./capture";

describe("toLegacyColors", () => {
  it("converts oklab values to rgb values", () => {
    const normalized = toLegacyColors("oklab(50% 0.1 -0.05 / 80%)");

    expect(normalized).not.toContain("oklab");
    expect(normalized).toMatch(/^rgba?\(/);
  });

  it("removes unsupported color functions from larger declarations", () => {
    const normalized = toLegacyColors(
      "linear-gradient(oklab(60% 0.1 0.05), color-mix(in srgb, white 20%, transparent))",
    );

    expect(normalized).not.toMatch(/oklab|color-mix/i);
  });
});

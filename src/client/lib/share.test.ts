import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveShareText,
  cardActions,
  copyToClipboard,
  shareText,
} from "./share";

describe("shareText", () => {
  it("labels the sentence as a remembered, unverified line above the URL", () => {
    expect(shareText("never give up", "https://www.youtube.com/watch?v=vid1")).toBe(
      "Remembered line: “never give up” (not verified)\nhttps://www.youtube.com/watch?v=vid1",
    );
  });

  it("returns only the URL when the sentence is empty", () => {
    expect(shareText("", "https://www.youtube.com/watch?v=vid1")).toBe(
      "https://www.youtube.com/watch?v=vid1",
    );
    expect(shareText("   ", "https://www.youtube.com/watch?v=vid1")).toBe(
      "https://www.youtube.com/watch?v=vid1",
    );
  });

  it("always includes the URL", () => {
    const url = "https://www.youtube.com/watch?v=vid9";
    expect(shareText("some line", url)).toContain(url);
    expect(shareText("", url)).toContain(url);
  });

  it("marks the output as not verified", () => {
    expect(shareText("some line", "https://www.youtube.com/watch?v=vid1")).toContain(
      "(not verified)",
    );
  });
});

describe("archiveShareText", () => {
  it("puts the video title above the URL", () => {
    expect(
      archiveShareText("My quantum bicycle build", "https://www.youtube.com/watch?v=vid1"),
    ).toBe("My quantum bicycle build\nhttps://www.youtube.com/watch?v=vid1");
  });

  it("returns only the URL when the title is empty", () => {
    expect(archiveShareText("", "https://www.youtube.com/watch?v=vid1")).toBe(
      "https://www.youtube.com/watch?v=vid1",
    );
    expect(archiveShareText("   ", "https://www.youtube.com/watch?v=vid1")).toBe(
      "https://www.youtube.com/watch?v=vid1",
    );
  });

  it("contains nothing beyond the title and URL", () => {
    const title = "Cooking pasta for dinner";
    const url = "https://www.youtube.com/watch?v=vid2";
    const output = archiveShareText(title, url);
    expect(output).toBe(`${title}\n${url}`);
    expect(output).not.toContain("caption");
  });
});

describe("copyToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the async clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyToClipboard("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when the clipboard API rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const area = {
      value: "",
      setAttribute: vi.fn(),
      style: {} as Record<string, string>,
      select: vi.fn(),
    };
    const body = { appendChild: vi.fn(), removeChild: vi.fn() };
    const execCommand = vi.fn().mockReturnValue(true);
    vi.stubGlobal("document", {
      createElement: vi.fn().mockReturnValue(area),
      execCommand,
      body,
    });
    await expect(copyToClipboard("hello")).resolves.toBe(true);
    expect(area.value).toBe("hello");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(body.removeChild).toHaveBeenCalledWith(area);
  });

  it("falls back to execCommand when there is no clipboard API", async () => {
    vi.stubGlobal("navigator", {});
    const area = {
      value: "",
      setAttribute: vi.fn(),
      style: {} as Record<string, string>,
      select: vi.fn(),
    };
    const body = { appendChild: vi.fn(), removeChild: vi.fn() };
    vi.stubGlobal("document", {
      createElement: vi.fn().mockReturnValue(area),
      execCommand: vi.fn().mockReturnValue(true),
      body,
    });
    await expect(copyToClipboard("hello")).resolves.toBe(true);
  });

  it("resolves false when nothing works, without throwing", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", undefined);
    await expect(copyToClipboard("hello")).resolves.toBe(false);
  });

  it("resolves false when execCommand reports failure", async () => {
    vi.stubGlobal("navigator", {});
    const area = {
      value: "",
      setAttribute: vi.fn(),
      style: {} as Record<string, string>,
      select: vi.fn(),
    };
    const body = { appendChild: vi.fn(), removeChild: vi.fn() };
    vi.stubGlobal("document", {
      createElement: vi.fn().mockReturnValue(area),
      execCommand: vi.fn().mockReturnValue(false),
      body,
    });
    await expect(copyToClipboard("hello")).resolves.toBe(false);
    expect(body.removeChild).toHaveBeenCalledWith(area);
  });
});

describe("cardActions", () => {
  it("shows every action for a found result with a loaded image", () => {
    expect(cardActions({ found: true }, true)).toEqual({
      share: true,
      download: true,
      copyLink: true,
    });
  });

  it("hides download for a found result without a loaded image", () => {
    expect(cardActions({ found: true }, false)).toEqual({
      share: true,
      download: false,
      copyLink: true,
    });
  });

  it("hides share and download for a not-found result", () => {
    expect(cardActions({ found: false }, false)).toEqual({
      share: false,
      download: false,
      copyLink: true,
    });
    expect(cardActions({ found: false }, true)).toEqual({
      share: false,
      download: false,
      copyLink: true,
    });
  });
});

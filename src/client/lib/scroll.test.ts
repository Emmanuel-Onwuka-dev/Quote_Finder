import { describe, expect, it } from "vitest";
import { FOLLOW_NEAR_BOTTOM_PX, shouldFollowToBottom } from "./scroll";

describe("shouldFollowToBottom", () => {
  it("follows right after the user's own submit, wherever they are", () => {
    expect(
      shouldFollowToBottom({
        scrollY: 0,
        viewportHeight: 800,
        contentHeight: 4000,
        force: true,
      }),
    ).toBe(true);
  });

  it("follows when the viewport is at the page bottom", () => {
    expect(
      shouldFollowToBottom({
        scrollY: 1200,
        viewportHeight: 800,
        contentHeight: 2000,
        force: false,
      }),
    ).toBe(true);
  });

  it(`follows within ${FOLLOW_NEAR_BOTTOM_PX}px of the bottom`, () => {
    expect(
      shouldFollowToBottom({
        scrollY: 1200 - FOLLOW_NEAR_BOTTOM_PX,
        viewportHeight: 800,
        contentHeight: 2000,
        force: false,
      }),
    ).toBe(true);
  });

  it("leaves the user alone when they scrolled up to read history", () => {
    expect(
      shouldFollowToBottom({
        scrollY: 0,
        viewportHeight: 800,
        contentHeight: 4000,
        force: false,
      }),
    ).toBe(false);
  });

  it("follows when the whole page fits in the viewport", () => {
    expect(
      shouldFollowToBottom({
        scrollY: 0,
        viewportHeight: 800,
        contentHeight: 600,
        force: false,
      }),
    ).toBe(true);
  });
});

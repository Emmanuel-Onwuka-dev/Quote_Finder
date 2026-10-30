// Pure scroll-follow decision for the chat view: while a search runs, the
// page stays pinned to the bottom so new rows and the result appear above
// the composer — unless the user scrolled up to read history. Unit tested
// in scroll.test.ts.

/** Pinned when the viewport bottom is within this distance of the page end. */
export const FOLLOW_NEAR_BOTTOM_PX = 120;

export function shouldFollowToBottom(args: {
  scrollY: number;
  viewportHeight: number;
  contentHeight: number;
  /** The user's own submit/retry: always bring the new turn into view. */
  force: boolean;
}): boolean {
  if (args.force) return true;
  return (
    args.contentHeight - (args.scrollY + args.viewportHeight) <=
    FOLLOW_NEAR_BOTTOM_PX
  );
}

// Session turn helpers: a cancelled search is dropped from the page, so the
// history holds finished searches only. Unit tested in turns.test.ts.

/** False for a cancelled turn, true for any other status. */
export function shouldKeepTurn(turn: { status: string }): boolean {
  return turn.status !== "cancelled";
}

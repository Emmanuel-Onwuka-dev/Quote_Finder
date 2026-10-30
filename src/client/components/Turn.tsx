import { useEffect, useRef } from "react";
import type { LocateResult, ProgressUpdate } from "../hooks/useQuoteStream";
import type { SearchInput } from "./Composer";
import { Progress } from "./Progress";

export interface TurnState {
  id: number;
  input: SearchInput;
  window: string;
  status: "streaming" | "done" | "error";
  progress: ProgressUpdate[];
  result: LocateResult | null;
  error: string | null;
}

interface TurnProps {
  turn: TurnState;
  running: boolean;
  onRetry: (input: SearchInput) => void;
}

export function Turn({ turn, running, onRetry }: TurnProps) {
  const ref = useRef<HTMLLIElement>(null);

  useEffect(() => {
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    ref.current?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    });
  }, []);

  return (
    <li
      ref={ref}
      className="scroll-mt-6 rounded-xl border border-border bg-card p-5"
    >
      <p className="font-mono text-sm text-muted">
        {turn.input.creator || "Any creator"} · {turn.window}
      </p>
      <p className="mt-2 font-display text-xl">
        &ldquo;{turn.input.quote}&rdquo;
      </p>
      {turn.input.scene && (
        <p className="mt-2 text-muted">{turn.input.scene}</p>
      )}

      {turn.status === "streaming" && <Progress events={turn.progress} />}

      {turn.status === "error" && (
        <div className="mt-4 border-t border-border pt-4">
          <h3 className="font-display text-lg font-bold">
            The search didn&apos;t finish
          </h3>
          <p className="mt-1 text-muted">{turn.error}</p>
          <button
            type="button"
            onClick={() => onRetry(turn.input)}
            disabled={running}
            className="mt-3 rounded-lg border border-border px-4 py-2 font-medium text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            Try again
          </button>
        </div>
      )}

      {turn.status === "done" && turn.result && (
        <div className="mt-4 border-t border-border pt-4">
          {turn.result.found ? (
            <p>
              <span className="font-medium">{turn.result.videoTitle}</span>{" "}
              <span className="font-mono text-sm text-muted">
                {turn.result.videoUrl}
              </span>
            </p>
          ) : (
            <p className="text-muted">
              No confident match — {turn.result.candidates.length} possible
              matches.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

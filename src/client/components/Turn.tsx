import type { LocateResult, ProgressUpdate } from "../hooks/useQuoteStream";
import {
  ArchiveResultCard,
  RefreshNotes,
  type ArchiveSearchResult,
} from "./ArchiveResultCard";
import { CandidateList } from "./CandidateList";
import type { SearchInput } from "./Composer";
import { Progress } from "./Progress";
import { ResultCard } from "./ResultCard";

export interface TurnState {
  id: number;
  input: SearchInput;
  timeWindow: string;
  status: "streaming" | "done" | "error";
  progress: ProgressUpdate[];
  result: LocateResult | null;
  archiveResult: ArchiveSearchResult | null;
  error: string | null;
}

interface TurnProps {
  turn: TurnState;
  running: boolean;
  onRetry: (input: SearchInput) => void;
}

export function Turn({ turn, running, onRetry }: TurnProps) {
  const archiveMode = turn.input.channelId !== "";
  return (
    <li className="scroll-mt-6 rounded-xl border border-border bg-card p-5">
      <p className="font-mono text-sm text-muted">
        {archiveMode
          ? `${turn.input.channelTitle || "Creator"} · archive · ${turn.timeWindow}`
          : `${turn.input.creator || "Any creator"} · ${turn.timeWindow}`}
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

      {turn.status === "done" && turn.result && !archiveMode && (
        <>
          {turn.result.found ? (
            <ResultCard result={turn.result} timeWindow={turn.timeWindow} />
          ) : (
            <CandidateList
              candidates={turn.result.candidates}
              notes={turn.result.notes}
              publishedAt={turn.result.publishedAt}
              timeWindow={turn.timeWindow}
            />
          )}
        </>
      )}

      {turn.status === "done" && turn.archiveResult && archiveMode && (
        <>
          {turn.archiveResult.found ? (
            <ArchiveResultCard
              result={turn.archiveResult}
              timeWindow={turn.timeWindow}
            />
          ) : (
            <div className="mt-4 border-t border-border pt-4">
              <h3 className="font-display text-lg font-bold">
                No matching line in this archive
              </h3>
              <p className="mt-1 text-muted">
                Nothing in {turn.input.channelTitle || "this archive"} matches
                that wording closely enough.
              </p>
              <RefreshNotes result={turn.archiveResult} />
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
        </>
      )}
    </li>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { ArchiveSearchResult } from "./components/ArchiveResultCard";
import { LogoMark } from "./components/Brand";
import { Composer, type SearchInput } from "./components/Composer";
import { Turn, type TurnState } from "./components/Turn";
import {
  useQuoteStream,
  type LocateResult,
  type ProgressUpdate,
} from "./hooks/useQuoteStream";
import { timeWindowLabel } from "./lib/format";
import { shouldFollowToBottom } from "./lib/scroll";

export default function App() {
  const [turns, setTurns] = useState<TurnState[]>([]);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [archiveRunning, setArchiveRunning] = useState(false);
  const nextId = useRef(1);
  const forceFollowRef = useRef(false);
  const { running, start } = useQuoteStream();
  const busy = running || archiveRunning;

  // Chat-style follow: keep the newest turn's latest content in view above
  // the composer as progress streams in and the result lands. Never yanks
  // the user away from history they scrolled up to read — except right
  // after their own submit/retry, which always brings the new turn into view.
  useEffect(() => {
    if (turns.length === 0) return;
    const force = forceFollowRef.current;
    forceFollowRef.current = false;
    if (
      !shouldFollowToBottom({
        scrollY: window.scrollY,
        viewportHeight: window.innerHeight,
        contentHeight: document.documentElement.scrollHeight,
        force,
      })
    ) {
      return;
    }
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [turns]);

  const updateTurn = useCallback((id: number, patch: Partial<TurnState>) => {
    setTurns((prev) =>
      prev.map((turn) => (turn.id === id ? { ...turn, ...patch } : turn)),
    );
  }, []);

  const startArchiveSearch = useCallback(
    async (input: SearchInput) => {
      const id = nextId.current++;
      const timeWindow = timeWindowLabel(input.sinceDays);
      setComposerError(null);
      forceFollowRef.current = true;
      setArchiveRunning(true);
      setTurns((prev) => [
        ...prev,
        {
          id,
          input,
          timeWindow,
          status: "streaming",
          progress: [
            {
              stage: `Searching ${input.channelTitle || "creator"}'s archive`,
              detail: "",
            },
          ],
          result: null,
          archiveResult: null,
          error: null,
        },
      ]);
      setResetKey((key) => key + 1);
      try {
        const res = await fetch("/api/archive/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channelId: input.channelId,
            quote: input.quote,
            sinceDays: input.sinceDays,
          }),
        });
        if (!res.ok) {
          let message = `Archive search failed (${res.status})`;
          try {
            const data = (await res.json()) as { message?: string };
            if (data.message) {
              message = data.message;
            }
          } catch {
            // Keep the status fallback.
          }
          throw new Error(message);
        }
        const data = (await res.json()) as ArchiveSearchResult;
        updateTurn(id, { status: "done", archiveResult: data });
      } catch (error) {
        updateTurn(id, {
          status: "error",
          error:
            error instanceof Error ? error.message : "Archive search failed.",
        });
      } finally {
        setArchiveRunning(false);
      }
    },
    [updateTurn],
  );

  const startSearch = useCallback(
    (input: SearchInput) => {
      if (input.channelId !== "") {
        void startArchiveSearch(input);
        return;
      }
      const id = nextId.current++;
      const timeWindow = timeWindowLabel(input.sinceDays);
      setComposerError(null);
      forceFollowRef.current = true;
      let started = false;
      start(input, {
        onStarted: () => {
          started = true;
          setTurns((prev) => [
            ...prev,
            {
              id,
              input,
              timeWindow,
              status: "streaming",
              progress: [],
              result: null,
              archiveResult: null,
              error: null,
            },
          ]);
          setResetKey((key) => key + 1);
        },
        onProgress: (update: ProgressUpdate) => {
          setTurns((prev) =>
            prev.map((turn) =>
              turn.id === id
                ? { ...turn, progress: [...turn.progress, update] }
                : turn,
            ),
          );
        },
        onResult: (result: LocateResult) => {
          updateTurn(id, { status: "done", result });
        },
        onError: (message: string) => {
          if (started) {
            updateTurn(id, { status: "error", error: message });
          } else {
            setTurns((prev) => [
              ...prev,
              {
                id,
                input,
                timeWindow,
                status: "error",
                progress: [],
                result: null,
                archiveResult: null,
                error: message,
              },
            ]);
            setComposerError(message);
          }
        },
      });
    },
    [start, startArchiveSearch, updateTurn],
  );

  return (
    <div className="min-h-screen bg-background font-body text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-[42rem] flex-col px-4 sm:px-6">
        <header className="pb-6 pt-10">
          <div className="flex items-center gap-3">
            <LogoMark className="text-4xl" />
            <h1 className="font-display text-3xl font-bold tracking-tight">
              Quotefinder
            </h1>
          </div>
          <p className="mt-3 text-lg text-muted">
            Say it however you remember it — the wording doesn&apos;t have to
            be right.
          </p>
          <p className="mt-2">
            <a href="/creator" className="text-sm text-accent underline">
              For creators: connect your channel
            </a>
          </p>
        </header>

        <main className="flex-1 pb-8">
          {turns.length === 0 ? (
            <p className="text-muted">
              No searches yet — try a line you remember.
            </p>
          ) : (
            <ol className="space-y-6">
              {turns.map((turn) => (
                <Turn
                  key={turn.id}
                  turn={turn}
                  running={busy}
                  onRetry={startSearch}
                />
              ))}
            </ol>
          )}
        </main>

        <div className="bg-background pb-6 pt-2">
          <Composer
            disabled={busy}
            serverError={composerError}
            resetKey={resetKey}
            onSubmit={startSearch}
          />
        </div>
      </div>
    </div>
  );
}

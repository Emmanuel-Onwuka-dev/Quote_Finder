import { useCallback, useEffect, useRef, useState } from "react";
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
import { shouldKeepTurn } from "./lib/turns";

export default function App() {
  const [turns, setTurns] = useState<TurnState[]>([]);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const nextId = useRef(1);
  const forceFollowRef = useRef(false);
  const { running, start, cancel } = useQuoteStream();
  const busy = running;

  // Chat-style follow: keep the newest turn's latest content in view above
  // the composer as progress streams in and the result lands. Never yanks
  // the user away from history they scrolled up to read, except right
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

  const startSearch = useCallback(
    (input: SearchInput) => {
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
        onCancelled: () => {
          setTurns((prev) =>
            prev
              .map(
                (turn): TurnState =>
                  turn.id === id ? { ...turn, status: "cancelled" } : turn,
              )
              .filter(shouldKeepTurn),
          );
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
                error: message,
              },
            ]);
            setComposerError(message);
          }
        },
      });
    },
    [start, updateTurn],
  );

  const clearHistory = useCallback(() => {
    cancel();
    setTurns([]);
    setComposerError(null);
  }, [cancel]);

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
            Know roughly what a video was about? Find it.
          </p>
          <p className="mt-2">
            <a href="/creator" className="text-sm text-accent underline">
              For creators: connect your channel
            </a>
          </p>
          <p className="mt-2">
            <a href="/creator" className="text-sm text-accent underline">
              Find the moment you said it, in your own videos.
            </a>
          </p>
        </header>

        <main className="flex-1 pb-8">
          {turns.length === 0 ? (
            <p className="text-muted">
              No searches yet. Try describing a video.
            </p>
          ) : (
            <>
              <div className="mb-4 flex justify-end">
                <button
                  type="button"
                  onClick={clearHistory}
                  className="rounded-lg border border-border px-4 py-2 font-medium text-foreground"
                >
                  Clear history
                </button>
              </div>
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
            </>
          )}
        </main>

        <div className="bg-background pb-6 pt-2">
          <Composer
            disabled={busy}
            serverError={composerError}
            resetKey={resetKey}
            onSubmit={startSearch}
            onCancel={cancel}
          />
        </div>

        <footer className="pb-6 text-center">
          <a href="/privacy" className="text-sm text-accent underline">
            Privacy
          </a>
        </footer>
      </div>
    </div>
  );
}

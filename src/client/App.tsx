import { useCallback, useRef, useState } from "react";
import { LogoMark } from "./components/Brand";
import { Composer, type SearchInput } from "./components/Composer";
import { Turn, type TurnState } from "./components/Turn";
import {
  useQuoteStream,
  type LocateResult,
  type ProgressUpdate,
} from "./hooks/useQuoteStream";
import { timeWindowLabel } from "./lib/format";

export default function App() {
  const [turns, setTurns] = useState<TurnState[]>([]);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const nextId = useRef(1);
  const { running, start } = useQuoteStream();

  const updateTurn = useCallback((id: number, patch: Partial<TurnState>) => {
    setTurns((prev) =>
      prev.map((turn) => (turn.id === id ? { ...turn, ...patch } : turn)),
    );
  }, []);

  const startSearch = useCallback(
    (input: SearchInput) => {
      const id = nextId.current++;
      const window = timeWindowLabel(input.sinceDays);
      setComposerError(null);
      let started = false;
      start(input, {
        onStarted: () => {
          started = true;
          setTurns((prev) => [
            ...prev,
            {
              id,
              input,
              window,
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
        onError: (message: string) => {
          if (started) {
            updateTurn(id, { status: "error", error: message });
          } else {
            setTurns((prev) => [
              ...prev,
              {
                id,
                input,
                window,
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
                  running={running}
                  onRetry={startSearch}
                />
              ))}
            </ol>
          )}
        </main>

        <div className="bg-background pb-6 pt-2 md:sticky md:bottom-0">
          <Composer
            disabled={running}
            serverError={composerError}
            resetKey={resetKey}
            onSubmit={startSearch}
          />
        </div>
      </div>
    </div>
  );
}

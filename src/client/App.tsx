import { useRef, useState } from "react";
import { LogoMark } from "./components/Brand";
import { Composer, type SearchInput } from "./components/Composer";
import { timeWindowLabel } from "./lib/format";

interface TurnDraft {
  id: number;
  input: SearchInput;
}

export default function App() {
  const [turns, setTurns] = useState<TurnDraft[]>([]);
  const nextId = useRef(1);

  const handleSubmit = (input: SearchInput) => {
    const id = nextId.current++;
    setTurns((prev) => [...prev, { id, input }]);
  };

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
                <li
                  key={turn.id}
                  className="rounded-xl border border-border bg-card p-5"
                >
                  <p className="font-mono text-sm text-muted">
                    {turn.input.creator || "Any creator"} ·{" "}
                    {timeWindowLabel(turn.input.sinceDays)}
                  </p>
                  <p className="mt-2 font-display text-xl">
                    &ldquo;{turn.input.quote}&rdquo;
                  </p>
                  {turn.input.scene && (
                    <p className="mt-2 text-muted">{turn.input.scene}</p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </main>

        <div className="bg-background pb-6 pt-2 md:sticky md:bottom-0">
          <Composer
            disabled={false}
            serverError={null}
            resetKey={0}
            onSubmit={handleSubmit}
          />
        </div>
      </div>
    </div>
  );
}

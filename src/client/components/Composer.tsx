import { useEffect, useRef, useState } from "react";
import { TIME_WINDOW_OPTIONS } from "../lib/format";

export interface SearchInput {
  quote: string;
  creator: string;
  scene: string;
  sinceDays: number;
  /** Listed-archive scope; "" means the usual YouTube path. */
  channelId: string;
  channelTitle: string;
}

interface ListedCreator {
  channelId: string;
  channelTitle: string;
  videoCount: number;
}

interface ComposerProps {
  disabled: boolean;
  serverError: string | null;
  /** Increment to clear quote/scene/window once a search starts. */
  resetKey: number;
  onSubmit: (input: SearchInput) => void;
}

const CUSTOM_DAYS_MAX = 3650;

function clampCustomDays(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return 0;
  return Math.min(CUSTOM_DAYS_MAX, Math.max(0, n));
}

const inputClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground placeholder:text-muted disabled:opacity-60";

export function Composer({
  disabled,
  serverError,
  resetKey,
  onSubmit,
}: ComposerProps) {
  const [quote, setQuote] = useState("");
  const [creator, setCreator] = useState("");
  const [scene, setScene] = useState("");
  const [preset, setPreset] = useState<number | "custom">(0);
  const [customDays, setCustomDays] = useState("30");
  const [channelId, setChannelId] = useState("");
  const [creators, setCreators] = useState<ListedCreator[] | null>(null);
  const customInputRef = useRef<HTMLInputElement>(null);
  const lastResetKey = useRef(resetKey);

  useEffect(() => {
    let cancelled = false;
    const loadCreators = async () => {
      try {
        const res = await fetch("/api/archive/creators");
        if (!res.ok) {
          throw new Error(`status ${res.status}`);
        }
        const data = (await res.json()) as {
          creators?: ListedCreator[];
        };
        if (!cancelled) {
          setCreators(data.creators ?? []);
        }
      } catch {
        if (!cancelled) {
          setCreators([]);
        }
      }
    };
    void loadCreators();
    return () => {
      cancelled = true;
    };
  }, []);

  // Clear quote/scene/window when the parent confirms a search started.
  // The creator and archive scope are kept, per spec.
  useEffect(() => {
    if (lastResetKey.current === resetKey) return;
    lastResetKey.current = resetKey;
    setQuote("");
    setScene("");
    setPreset(0);
  }, [resetKey]);

  const sinceDays =
    preset === "custom" ? clampCustomDays(customDays) : preset;
  const quoteBlank = quote.trim() === "";
  const archiveMode = channelId !== "";

  const submit = () => {
    if (disabled || quoteBlank) return;
    onSubmit({
      quote: quote.trim(),
      creator: creator.trim(),
      scene: scene.trim(),
      sinceDays,
      channelId,
      channelTitle:
        creators?.find((entry) => entry.channelId === channelId)
          ?.channelTitle ?? "",
    });
  };

  const selectCustom = () => {
    setPreset("custom");
    requestAnimationFrame(() => customInputRef.current?.focus());
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="rounded-xl border border-border bg-card p-5"
    >
      <div>
        <label htmlFor="quote" className="mb-1 block font-medium">
          Quote
        </label>
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="select-none font-display text-4xl leading-none text-accent"
          >
            &ldquo;
          </span>
          <input
            id="quote"
            type="text"
            value={quote}
            onChange={(e) => setQuote(e.target.value)}
            placeholder="The line you remember"
            required
            disabled={disabled}
            className={`${inputClass} flex-1`}
          />
          <span
            aria-hidden="true"
            className="select-none font-display text-4xl leading-none text-accent"
          >
            &rdquo;
          </span>
        </div>
      </div>

      {creators !== null && creators.length > 0 && (
        <div className="mt-3">
          <label htmlFor="archive-scope" className="mb-1 block font-medium">
            Search in
          </label>
          <select
            id="archive-scope"
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            disabled={disabled}
            className={inputClass}
          >
            <option value="">All of YouTube</option>
            {creators.map((entry) => (
              <option key={entry.channelId} value={entry.channelId}>
                {entry.channelTitle}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="mt-3">
        <label htmlFor="creator" className="mb-1 block font-medium">
          Creator
        </label>
        <input
          id="creator"
          type="text"
          value={creator}
          onChange={(e) => setCreator(e.target.value)}
          placeholder="Creator (optional)"
          disabled={disabled || archiveMode}
          className={inputClass}
        />
      </div>

      <div className="mt-3">
        <label htmlFor="scene" className="mb-1 block font-medium">
          Scene
        </label>
        <textarea
          id="scene"
          rows={2}
          value={scene}
          onChange={(e) => setScene(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          }}
          placeholder="describe the scene — what was happening, who was on screen"
          disabled={disabled || archiveMode}
          className={inputClass}
        />
      </div>
      {archiveMode && (
        <p className="mt-2 text-sm text-muted">
          Creator and scene don&apos;t apply to archive search.
        </p>
      )}

      <fieldset className="mt-4">
        <legend className="font-medium">Time window</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {TIME_WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={preset === opt.value}
              onClick={() => setPreset(opt.value)}
              disabled={disabled}
              className={
                preset === opt.value
                  ? "rounded-full bg-accent px-3 py-1 text-sm font-medium text-accent-foreground disabled:opacity-60"
                  : "rounded-full border border-border px-3 py-1 text-sm text-foreground disabled:opacity-60"
              }
            >
              {opt.label}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={preset === "custom"}
            onClick={selectCustom}
            disabled={disabled}
            className={
              preset === "custom"
                ? "rounded-full bg-accent px-3 py-1 text-sm font-medium text-accent-foreground disabled:opacity-60"
                : "rounded-full border border-border px-3 py-1 text-sm text-foreground disabled:opacity-60"
            }
          >
            Custom
          </button>
        </div>
        {preset === "custom" && (
          <div className="mt-2 flex items-center gap-2">
            <label htmlFor="custom-days" className="text-sm text-muted">
              Days back, 0 to 3650
            </label>
            <input
              ref={customInputRef}
              id="custom-days"
              type="number"
              min={0}
              max={CUSTOM_DAYS_MAX}
              value={customDays}
              onChange={(e) => setCustomDays(e.target.value)}
              disabled={disabled}
              className="w-28 rounded-lg border border-border bg-background px-3 py-1 text-foreground disabled:opacity-60"
            />
          </div>
        )}
      </fieldset>

      {serverError && (
        <p role="alert" className="mt-3 text-destructive">
          {serverError}
        </p>
      )}

      <button
        type="submit"
        disabled={disabled || quoteBlank}
        className="mt-4 rounded-lg bg-accent px-5 py-2.5 font-medium text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        Search
      </button>
    </form>
  );
}

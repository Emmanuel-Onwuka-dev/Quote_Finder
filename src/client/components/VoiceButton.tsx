import { useEffect, useRef } from "react";
import type { VoiceInput } from "../hooks/use-voice-input";
import { VOICE_METER_BARS } from "../lib/audio";

function MicIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="21" />
    </svg>
  );
}

function StopIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
    </svg>
  );
}

/** Microphone toggle for voice input (§9): mic idle, square + destructive
 * color while recording, spinner while transcribing. */
export function VoiceButton({
  disabled,
  voice,
  dictateLabel = "Dictate the quote",
}: {
  disabled: boolean;
  voice: VoiceInput;
  dictateLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={voice.toggle}
      disabled={disabled || voice.transcribing}
      aria-label={
        voice.recording
          ? "Stop recording"
          : voice.transcribing
            ? "Muse Voice Transcribe is turning your speech into text"
            : dictateLabel
      }
      className={
        voice.recording
          ? "rounded-lg border border-destructive p-2.5 text-destructive disabled:opacity-60"
          : "rounded-lg border border-border p-2.5 text-accent disabled:opacity-60"
      }
    >
      {voice.recording ? (
        <StopIcon />
      ) : voice.transcribing ? (
        <span className="spinner" aria-hidden="true" />
      ) : (
        <MicIcon />
      )}
    </button>
  );
}

const METER_WIDTH = 64;
const METER_HEIGHT = 24;
const METER_BAR_GAP = 4;
const METER_MIN_HEIGHT = 2;

/** Live voice meter: canvas bars that bounce while the person talks
 * and fall flat in silence. Decorative. The status lines carry the
 * recording state for assistive tech. */
export function VoiceMeter({ voice }: { voice: VoiceInput }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { recording, getMeterLevels } = voice;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    canvas.width = METER_WIDTH * dpr;
    canvas.height = METER_HEIGHT * dpr;
    ctx.scale(dpr, dpr);
    const styles = getComputedStyle(canvas);
    const color =
      styles.getPropertyValue("--color-destructive").trim() ||
      styles.getPropertyValue("--color-accent").trim();
    const barWidth =
      (METER_WIDTH - METER_BAR_GAP * (VOICE_METER_BARS - 1)) /
      VOICE_METER_BARS;
    const draw = (levels: readonly number[]) => {
      ctx.clearRect(0, 0, METER_WIDTH, METER_HEIGHT);
      ctx.fillStyle = color;
      for (let i = 0; i < VOICE_METER_BARS; i += 1) {
        const height = Math.max(
          METER_MIN_HEIGHT,
          (levels[i] ?? 0) * (METER_HEIGHT - 2),
        );
        ctx.fillRect(
          i * (barWidth + METER_BAR_GAP),
          METER_HEIGHT - height,
          barWidth,
          height,
        );
      }
    };
    if (
      !recording ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      draw(new Array(VOICE_METER_BARS).fill(0));
      return;
    }
    let frame = 0;
    const tick = () => {
      draw(getMeterLevels() ?? new Array(VOICE_METER_BARS).fill(0));
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [recording, getMeterLevels]);

  return (
    <canvas
      ref={canvasRef}
      width={METER_WIDTH}
      height={METER_HEIGHT}
      className="h-6 w-16 shrink-0"
      aria-hidden="true"
    />
  );
}

/** Recording/transcribing/error lines that sit under a voice input. */
export function VoiceStatus({ voice }: { voice: VoiceInput }) {
  return (
    <>
      {voice.recording && (
        <p className="mt-2 text-sm text-muted">
          Listening… tap the square when you&apos;re done.
        </p>
      )}
      {voice.transcribing && (
        <p className="mt-2 text-sm text-muted">Writing down what you said…</p>
      )}
      {voice.error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {voice.error}
        </p>
      )}
    </>
  );
}

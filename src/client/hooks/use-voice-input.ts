import { useCallback, useEffect, useRef, useState } from "react";
import {
  appendTranscriptChunk,
  computeMeterLevels,
  concatSamples,
  encodeWavPcm16,
  finalVoiceError,
  interimCallAllowed,
  resampleLinear,
  shouldShowVoiceError,
  VOICE_METER_BARS,
  VOICE_SAMPLE_RATE,
  type VoiceErrorStage,
} from "../lib/audio";

/** Live captions: transcribe a chunk this often while recording, so
 * words appear before the speaker stops. The full recording is still
 * transcribed on stop and replaces the interim text. */
const INTERIM_SECONDS = 4;

export interface VoiceInput {
  recording: boolean;
  transcribing: boolean;
  error: string | null;
  toggle: () => void;
  /** Live meter levels (0–1 per bar) while recording, else null. The
   * returned array is reused. Read it synchronously each frame. */
  getMeterLevels: () => number[] | null;
}

/**
 * §9 voice input: records the microphone with an AudioWorklet, converts
 * the capture to 16 kHz mono WAV, POSTs it to /api/transcribe, and
 * hands the returned text to onText (the quote box). While recording,
 * interim chunks are transcribed live and onText receives the dictated
 * text so far; on stop, the full recording replaces it. One recording
 * at a time; leaving the page stops the callbacks.
 */
export function useVoiceInput({
  onText,
}: {
  onText: (text: string) => void;
}): VoiceInput {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recordingRef = useRef(false);
  const transcribingRef = useRef(false);
  const cancelledRef = useRef(false);
  const onTextRef = useRef(onText);
  const captureRef = useRef<{
    stream: MediaStream;
    context: AudioContext;
    node: AudioWorkletNode;
    source: MediaStreamAudioSourceNode;
    analyser: AnalyserNode;
    chunks: Float32Array[];
  } | null>(null);
  const smoothedLevelsRef = useRef<number[]>(
    new Array(VOICE_METER_BARS).fill(0),
  );
  const meterBinsRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const interimTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const interimCutRef = useRef(0);
  const interimBusyRef = useRef(false);
  const interimSentRef = useRef(0);
  const dictatedRef = useRef("");
  const sessionRef = useRef(0);
  const startingRef = useRef(false);

  const clearInterimTimer = useCallback(() => {
    if (interimTimerRef.current !== null) {
      clearInterval(interimTimerRef.current);
      interimTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  useEffect(() => {
    cancelledRef.current = false;
    const capture = captureRef;
    return () => {
      cancelledRef.current = true;
      clearInterimTimer();
      const current = capture.current;
      capture.current = null;
      recordingRef.current = false;
      if (current) {
        for (const track of current.stream.getTracks()) {
          track.stop();
        }
        current.source.disconnect();
        current.node.disconnect();
        current.analyser.disconnect();
        void current.context.close().catch(() => {});
      }
    };
  }, [clearInterimTimer]);

  const stopTracks = useCallback(() => {
    const current = captureRef.current;
    captureRef.current = null;
    recordingRef.current = false;
    if (!current) {
      return null;
    }
    for (const track of current.stream.getTracks()) {
      track.stop();
    }
    current.source.disconnect();
    current.node.disconnect();
    current.analyser.disconnect();
    const { context, chunks } = current;
    void context.close().catch(() => {});
    return { sampleRate: context.sampleRate, chunks };
  }, []);

  const postWav = useCallback(
    async (chunks: Float32Array[], sampleRate: number): Promise<string> => {
      const mono = resampleLinear(
        concatSamples(chunks),
        sampleRate,
        VOICE_SAMPLE_RATE,
      );
      const wav = new Blob([encodeWavPcm16(mono, VOICE_SAMPLE_RATE)], {
        type: "audio/wav",
      });
      const form = new FormData();
      form.append("audio", wav, "audio.wav");
      const res = await fetch("/api/transcribe", {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        let message = `request failed with status ${res.status}`;
        try {
          const data = (await res.json()) as { message?: string };
          if (typeof data.message === "string" && data.message) {
            message = data.message;
          }
        } catch {
          // Keep the status fallback.
        }
        throw new Error(message);
      }
      const data = (await res.json()) as { text?: string };
      if (typeof data.text !== "string" || data.text === "") {
        throw new Error("the server sent back no text");
      }
      return data.text;
    },
    [],
  );

  const fail = useCallback((stage: VoiceErrorStage, message: string) => {
    if (shouldShowVoiceError(stage)) {
      setError(message);
    }
  }, []);

  const transcribeInterim = useCallback(
    async (session: number): Promise<void> => {
      const capture = captureRef.current;
      if (
        !capture ||
        session !== sessionRef.current ||
        !recordingRef.current ||
        cancelledRef.current ||
        interimBusyRef.current ||
        !interimCallAllowed(interimSentRef.current)
      ) {
        return;
      }
      const fresh = capture.chunks.slice(interimCutRef.current);
      if (fresh.length === 0) {
        return;
      }
      interimCutRef.current = capture.chunks.length;
      interimSentRef.current += 1;
      interimBusyRef.current = true;
      try {
        const text = await postWav(fresh, capture.context.sampleRate);
        if (
          cancelledRef.current ||
          session !== sessionRef.current ||
          !recordingRef.current
        ) {
          return;
        }
        dictatedRef.current = appendTranscriptChunk(dictatedRef.current, text);
        setError(null);
        onTextRef.current(dictatedRef.current);
      } catch (error) {
        // An interim failure doesn't stop the recording; the final
        // transcription on stop still gets its chance. Interim errors
        // stay silent: a quiet chunk is normal while dictating.
        if (
          !cancelledRef.current &&
          session === sessionRef.current &&
          recordingRef.current
        ) {
          fail(
            "interim",
            error instanceof Error ? error.message : "transcription failed",
          );
        }
      } finally {
        interimBusyRef.current = false;
      }
    },
    [fail, postWav],
  );

  const start = useCallback(async () => {
    if (startingRef.current || recordingRef.current) {
      return;
    }
    startingRef.current = true;
    setError(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("this browser can't access the microphone");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (cancelledRef.current) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
      }
      const context = new AudioContext();
      try {
        await context.audioWorklet.addModule("/capture-worklet.js");
      } catch {
        await context.close().catch(() => {});
        for (const track of stream.getTracks()) {
          track.stop();
        }
        throw new Error("this browser can't capture audio for dictation");
      }
      if (cancelledRef.current) {
        await context.close().catch(() => {});
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
      }
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, "quotefinder-capture");
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      const chunks: Float32Array[] = [];
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        chunks.push(event.data);
      };
      // Capture only: neither node is connected to the destination,
      // so the microphone never feeds back through the speakers.
      source.connect(node);
      source.connect(analyser);
      captureRef.current = { stream, context, node, source, analyser, chunks };
      recordingRef.current = true;
      setRecording(true);
      sessionRef.current += 1;
      const session = sessionRef.current;
      interimCutRef.current = 0;
      interimBusyRef.current = false;
      interimSentRef.current = 0;
      dictatedRef.current = "";
      clearInterimTimer();
      interimTimerRef.current = setInterval(() => {
        void transcribeInterim(session);
      }, INTERIM_SECONDS * 1000);
    } catch (err) {
      if (!cancelledRef.current) {
        fail(
          "start",
          err instanceof Error ? err.message : "could not start recording",
        );
      }
    } finally {
      startingRef.current = false;
    }
  }, [clearInterimTimer, fail, transcribeInterim]);

  const stopAndTranscribe = useCallback(async () => {
    clearInterimTimer();
    sessionRef.current += 1;
    const capture = stopTracks();
    setRecording(false);
    if (!capture || cancelledRef.current) {
      return;
    }
    transcribingRef.current = true;
    setTranscribing(true);
    try {
      const text = await postWav(capture.chunks, capture.sampleRate);
      if (cancelledRef.current) {
        return;
      }
      setError(null);
      onTextRef.current(text);
    } catch (err) {
      if (!cancelledRef.current) {
        fail(
          "final",
          finalVoiceError(
            err instanceof Error ? err.message : "transcription failed",
          ),
        );
      }
    } finally {
      transcribingRef.current = false;
      if (!cancelledRef.current) {
        setTranscribing(false);
      }
    }
  }, [clearInterimTimer, fail, postWav, stopTracks]);

  const toggle = useCallback(() => {
    if (transcribingRef.current || startingRef.current) {
      return;
    }
    if (recordingRef.current) {
      void stopAndTranscribe();
    } else {
      void start();
    }
  }, [start, stopAndTranscribe]);

  const getMeterLevels = useCallback((): number[] | null => {
    const analyser = captureRef.current?.analyser;
    if (!analyser || !recordingRef.current) {
      return null;
    }
    if (
      !meterBinsRef.current ||
      meterBinsRef.current.length !== analyser.frequencyBinCount
    ) {
      meterBinsRef.current = new Uint8Array(analyser.frequencyBinCount);
    }
    const bins = meterBinsRef.current;
    analyser.getByteFrequencyData(bins);
    const smoothed = smoothedLevelsRef.current;
    const fresh = computeMeterLevels(bins);
    for (let i = 0; i < smoothed.length; i += 1) {
      smoothed[i] = (smoothed[i] ?? 0) * 0.65 + (fresh[i] ?? 0) * 0.35;
    }
    return smoothed;
  }, []);

  return { recording, transcribing, error, toggle, getMeterLevels };
}

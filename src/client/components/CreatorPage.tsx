import { useCallback, useEffect, useRef, useState } from "react";
import type { ProgressUpdate } from "../hooks/useQuoteStream";
import { formatDate } from "../lib/format";
import { createSseParser } from "../lib/sse";
import { LogoMark } from "./Brand";
import { Progress } from "./Progress";

interface ArchiveCreator {
  channelId: string;
  channelTitle: string;
  videoCount: number;
  listed: boolean;
}

interface ArchiveStatus {
  creators: ArchiveCreator[];
  budget: { spentUnits: number; capUnits: number };
}

interface VideoEntry {
  id: string;
  title: string;
  publishedAt: string;
}

interface IndexSummary {
  indexed: Array<{
    videoId: string;
    trackKind: string;
    language: string;
    cueCount: number;
  }>;
  skipped: Array<{ videoId: string; reason: string }>;
  paused: boolean;
  message: string;
  spentUnits: number;
}

export function CreatorPage() {
  const [status, setStatus] = useState<ArchiveStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const params = new URLSearchParams(window.location.search);

  useEffect(() => {
    document.title = "Quotefinder creator archive";
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/archive/status");
      if (!res.ok) {
        throw new Error(`status ${res.status}`);
      }
      setStatus((await res.json()) as ArchiveStatus);
    } catch {
      setLoadError(
        "Could not reach the archive server. Is it running and configured?",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const disconnect = async (channelId: string, channelTitle: string) => {
    if (
      !window.confirm(
        `Disconnect ${channelTitle || "this channel"}? This revokes Quotefinder's access and deletes the stored sign-in.`,
      )
    ) {
      return;
    }
    setLeaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/archive/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId }),
      });
      if (res.status === 404) {
        await load();
        return;
      }
      if (!res.ok) {
        throw new Error(`status ${res.status}`);
      }
      const data = (await res.json()) as { revoked: boolean };
      if (!data.revoked) {
        setNotice(
          "Google reported an error revoking access, but the stored sign-in was deleted.",
        );
      }
      await load();
    } catch {
      setLoadError("Disconnect failed. Please try again.");
    } finally {
      setLeaving(false);
    }
  };

  const creators = status?.creators ?? null;

  return (
    <div className="min-h-screen bg-background font-body text-foreground">
      <div className="mx-auto w-full max-w-[42rem] px-4 py-10 sm:px-6">
        <header className="pb-6">
          <div className="flex items-center gap-3">
            <LogoMark className="text-4xl" />
            <h1 className="font-display text-3xl font-bold tracking-tight">
              Creator archive
            </h1>
          </div>
          <p className="mt-3 text-lg text-muted">
            Connect your YouTube channel so viewers can search your archive
            for a line they remember.
          </p>
          <p className="mt-2">
            <a href="/" className="text-accent underline">
              Back to search
            </a>
          </p>
        </header>

        <main className="rounded-xl border border-border bg-card p-5">
          {params.get("connected") === "1" && (
            <p className="mb-3 rounded-lg border border-border p-3">
              Connected. Your sign-in is stored on this server only.
            </p>
          )}
          {params.get("error") && (
            <p role="alert" className="mb-3 text-destructive">
              {params.get("error")}
            </p>
          )}
          {notice && <p className="mb-3 text-muted">{notice}</p>}
          {loadError && (
            <p role="alert" className="mb-3 text-destructive">
              {loadError}
            </p>
          )}
          {status && (
            <p className="mb-3 font-mono text-sm text-muted">
              Units used today: {status.budget.spentUnits} /{" "}
              {status.budget.capUnits}
            </p>
          )}
          {creators === null && !loadError && (
            <p className="text-muted">Checking connection…</p>
          )}
          {creators !== null && creators.length === 0 && (
            <div>
              <p>
                Quotefinder will ask Google for permission to read your own
                channel&apos;s captions. Nothing is listed for viewers until
                you turn that on.
              </p>
              <a
                href="/api/archive/oauth/start"
                className="mt-4 inline-block rounded-lg bg-accent px-5 py-2.5 font-medium text-accent-foreground"
              >
                Connect my YouTube channel
              </a>
            </div>
          )}
          {creators !== null &&
            creators.map((creator) => (
              <div
                key={creator.channelId}
                className="border-t border-border pt-3 first:border-t-0 first:pt-0"
              >
                <h2 className="font-display text-xl font-bold">
                  {creator.channelTitle || "Connected channel"}
                </h2>
                <p className="mt-1 font-mono text-sm text-muted">
                  Indexed videos: {creator.videoCount}
                </p>
                <CreatorIndexing
                  channelId={creator.channelId}
                  onDone={load}
                />
                <button
                  type="button"
                  onClick={() =>
                    void disconnect(creator.channelId, creator.channelTitle)
                  }
                  disabled={leaving}
                  className="mt-3 rounded-lg border border-border px-4 py-2 font-medium text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Disconnect and delete
                </button>
              </div>
            ))}
        </main>
      </div>
    </div>
  );
}

function CreatorIndexing({
  channelId,
  onDone,
}: {
  channelId: string;
  onDone: () => void;
}) {
  const [videos, setVideos] = useState<VideoEntry[] | null>(null);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>(
    undefined,
  );
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [videosError, setVideosError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressUpdate[]>([]);
  const [summary, setSummary] = useState<IndexSummary | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const loadVideos = useCallback(
    async (pageToken?: string) => {
      setLoadingVideos(true);
      setVideosError(null);
      try {
        const params = new URLSearchParams({ channelId });
        if (pageToken) {
          params.set("pageToken", pageToken);
        }
        const res = await fetch(`/api/archive/videos?${params.toString()}`);
        if (!res.ok) {
          throw new Error(`status ${res.status}`);
        }
        const data = (await res.json()) as {
          videos: VideoEntry[];
          nextPageToken?: string;
        };
        if (cancelledRef.current) {
          return;
        }
        setVideos((prev) =>
          pageToken && prev ? [...prev, ...data.videos] : data.videos,
        );
        setNextPageToken(data.nextPageToken);
        if (!pageToken) {
          setSelected(new Set(data.videos.slice(0, 20).map((v) => v.id)));
        }
      } catch {
        if (!cancelledRef.current) {
          setVideosError("Could not load the upload list.");
        }
      } finally {
        if (!cancelledRef.current) {
          setLoadingVideos(false);
        }
      }
    },
    [channelId],
  );

  useEffect(() => {
    void loadVideos(undefined);
  }, [loadVideos]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const runIndex = async () => {
    const ids =
      videos?.filter((video) => selected.has(video.id)).map((v) => v.id) ?? [];
    if (ids.length === 0 || running) {
      return;
    }
    setRunning(true);
    setProgress([]);
    setSummary(null);
    setRunError(null);
    try {
      const res = await fetch("/api/archive/index", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId, videoIds: ids }),
      });
      if (!res.ok || !res.body) {
        let message = `request failed (${res.status})`;
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
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (cancelledRef.current) {
          await reader.cancel().catch(() => {});
          return;
        }
        if (done) {
          break;
        }
        for (const evt of parser.feed(decoder.decode(value, { stream: true }))) {
          if (evt.event === "progress") {
            const data = JSON.parse(evt.data) as {
              stage?: string;
              detail?: string;
            };
            setProgress((prev) => [
              ...prev,
              { stage: data.stage ?? "", detail: data.detail ?? "" },
            ]);
          } else if (evt.event === "result") {
            setSummary(JSON.parse(evt.data) as IndexSummary);
            onDone();
            await reader.cancel().catch(() => {});
            return;
          } else if (evt.event === "error") {
            const data = JSON.parse(evt.data) as { message?: string };
            throw new Error(data.message || "Indexing failed");
          }
        }
      }
    } catch (error) {
      if (!cancelledRef.current) {
        setRunError(
          error instanceof Error ? error.message : "Indexing failed",
        );
      }
    } finally {
      if (!cancelledRef.current) {
        setRunning(false);
      }
    }
  };

  const titleOf = (videoId: string): string =>
    videos?.find((video) => video.id === videoId)?.title || videoId;

  return (
    <div className="mt-4 border-t border-border pt-3">
      <h3 className="font-display text-lg font-bold">Index videos</h3>
      {videosError && (
        <p role="alert" className="mt-2 text-destructive">
          {videosError}
        </p>
      )}
      {videos === null && !videosError && (
        <p className="mt-2 text-muted">Loading uploads…</p>
      )}
      {videos !== null && (
        <>
          {videos.length === 0 ? (
            <p className="mt-2 text-muted">No uploads found.</p>
          ) : (
            <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto">
              {videos.map((video) => (
                <li key={video.id}>
                  <label className="flex items-baseline gap-2">
                    <input
                      type="checkbox"
                      checked={selected.has(video.id)}
                      onChange={() => toggle(video.id)}
                      disabled={running}
                      className="translate-y-px"
                    />
                    <span className="font-medium">{video.title}</span>
                    <span className="font-mono text-sm text-muted">
                      {formatDate(video.publishedAt)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {nextPageToken && (
              <button
                type="button"
                onClick={() => void loadVideos(nextPageToken)}
                disabled={running || loadingVideos}
                className="rounded-lg border border-border px-4 py-2 font-medium text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                Load more
              </button>
            )}
            <button
              type="button"
              onClick={() => void runIndex()}
              disabled={running || selected.size === 0}
              className="rounded-lg bg-accent px-4 py-2 font-medium text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {running
                ? "Indexing…"
                : `Index selected (${selected.size})`}
            </button>
          </div>
        </>
      )}
      {running && <Progress events={progress} />}
      {runError && (
        <p role="alert" className="mt-3 text-destructive">
          {runError}
        </p>
      )}
      {summary && (
        <div className="mt-3">
          <h4 className="font-display font-bold">Index run</h4>
          {summary.paused && summary.message && (
            <p className="mt-1 rounded-lg border border-border p-3">
              {summary.message}
            </p>
          )}
          <ul className="mt-2 space-y-1">
            {summary.indexed.map((video) => (
              <li key={video.videoId}>
                <span aria-hidden="true" className="text-accent">
                  ✓{" "}
                </span>
                {titleOf(video.videoId)}{" "}
                <span className="font-mono text-sm text-muted">
                  {video.trackKind} · {video.cueCount} cues
                </span>
              </li>
            ))}
            {summary.skipped.map((video) => (
              <li key={video.videoId} className="text-muted">
                {titleOf(video.videoId)} — skipped ({video.reason})
              </li>
            ))}
          </ul>
          <p className="mt-2 font-mono text-sm text-muted">
            Units used today: {summary.spentUnits}
          </p>
        </div>
      )}
    </div>
  );
}

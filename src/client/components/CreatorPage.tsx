import { useCallback, useEffect, useState } from "react";
import { LogoMark } from "./Brand";

interface ArchiveCreator {
  channelId: string;
  channelTitle: string;
  videoCount: number;
  listed: boolean;
}

export function CreatorPage() {
  const [creators, setCreators] = useState<ArchiveCreator[] | null>(null);
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
      const data = (await res.json()) as { creators: ArchiveCreator[] };
      setCreators(data.creators);
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

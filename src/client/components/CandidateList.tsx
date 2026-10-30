import { useState } from "react";
import type { QuoteCandidate } from "../hooks/useQuoteStream";
import { formatDate, videoIdFromUrl, youtubeEmbedUrl } from "../lib/format";
import { openExternal } from "../lib/openExternal";

interface CandidateListProps {
  candidates: QuoteCandidate[];
  notes: string[];
  publishedAt: string;
  window: string;
}

const secondaryButton =
  "rounded-lg border border-border px-4 py-2 font-medium text-foreground";

export function CandidateList({
  candidates,
  notes,
  publishedAt,
  window,
}: CandidateListProps) {
  return (
    <div className="mt-4 border-t border-border pt-4">
      {notes.map((note, index) => (
        <p key={`${index}-${note.slice(0, 24)}`} className="text-muted">
          {note}
        </p>
      ))}
      <h3 className="mt-3 font-display text-lg font-bold">
        Possible matches
      </h3>
      <ul className="mt-3 space-y-4">
        {candidates.map((candidate, index) => (
          <CandidateItem
            key={`${index}-${candidate.url}`}
            candidate={candidate}
            publishedAt={publishedAt}
            window={window}
          />
        ))}
      </ul>
    </div>
  );
}

function CandidateItem({
  candidate,
  publishedAt,
  window,
}: {
  candidate: QuoteCandidate;
  publishedAt: string;
  window: string;
}) {
  const [playing, setPlaying] = useState(false);
  const videoId = videoIdFromUrl(candidate.url);
  const meta = [candidate.creator, formatDate(publishedAt), window]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className="border-t border-border pt-3 first:border-t-0 first:pt-0">
      <p className="font-medium">{candidate.title}</p>
      {candidate.reason && (
        <p className="text-sm text-muted">{candidate.reason}</p>
      )}
      {meta && <p className="mt-1 font-mono text-sm text-muted">{meta}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {videoId ? (
          <>
            <button
              type="button"
              onClick={() => setPlaying((open) => !open)}
              className={secondaryButton}
            >
              {playing ? "Hide player" : "Play here"}
            </button>
            <button
              type="button"
              onClick={() => openExternal(candidate.url)}
              className={secondaryButton}
            >
              Open on YouTube
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() =>
              openExternal(
                `https://www.youtube.com/results?search_query=${encodeURIComponent(candidate.title)}`,
              )
            }
            className={secondaryButton}
          >
            Search this title
          </button>
        )}
      </div>
      {playing && videoId && (
        <iframe
          className="mt-3 aspect-video w-full rounded-xl border border-border"
          src={youtubeEmbedUrl(videoId)}
          title={candidate.title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      )}
    </li>
  );
}

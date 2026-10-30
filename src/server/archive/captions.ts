// YouTube captions API for the creator archive (§4.2): list a video's
// caption tracks and download the SRT text. All calls use the creator's
// OAuth access token — an API key is not enough.

export const CAPTIONS_LIST_COST = 50;
export const CAPTIONS_DOWNLOAD_COST = 200;

const CAPTIONS_API = "https://www.googleapis.com/youtube/v3/captions";
const CAPTIONS_TIMEOUT_MS = 15000;

export interface CaptionTrack {
  id: string;
  language: string;
  name: string;
  trackKind: string;
  status: string;
}

interface CaptionsListPayload {
  items?: Array<{
    id?: string;
    snippet?: {
      language?: string;
      name?: string;
      trackKind?: string;
      status?: string;
    };
  }>;
}

export async function listCaptionTracks(
  videoId: string,
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<CaptionTrack[]> {
  const res = await fetchFn(
    `${CAPTIONS_API}?part=snippet&videoId=${encodeURIComponent(videoId)}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(CAPTIONS_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    throw new Error(`Caption track list failed (${res.status})`);
  }
  const items = ((await res.json()) as CaptionsListPayload).items ?? [];
  return items.flatMap((item) => {
    if (!item.id) {
      return [];
    }
    return [
      {
        id: item.id,
        language: item.snippet?.language ?? "",
        name: item.snippet?.name ?? "",
        trackKind: item.snippet?.trackKind ?? "",
        status: item.snippet?.status ?? "",
      },
    ];
  });
}

// Prefer human-uploaded tracks, then forced, then auto-generated, then
// anything else. Failed tracks are never usable.
const TRACK_PREFERENCE = ["standard", "forced", "asr"];

function rankOf(trackKind: string): number {
  const rank = TRACK_PREFERENCE.indexOf(trackKind);
  return rank < 0 ? TRACK_PREFERENCE.length : rank;
}

export function pickTrack(tracks: CaptionTrack[]): CaptionTrack | undefined {
  return tracks
    .filter((track) => track.status !== "failed")
    .slice()
    .sort((a, b) => rankOf(a.trackKind) - rankOf(b.trackKind))[0];
}

export async function downloadCaptions(
  trackId: string,
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchFn(
    `${CAPTIONS_API}/${encodeURIComponent(trackId)}?tfmt=srt`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(CAPTIONS_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    throw new Error(`Caption download failed (${res.status})`);
  }
  return res.text();
}

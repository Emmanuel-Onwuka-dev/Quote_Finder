// Video selection helpers for the creator archive page. The server takes
// at most 200 IDs per request, so the caller batches the result. Unit
// tested in select.test.ts.

/** The fields the selection helpers read from each video entry. */
export interface IndexableVideo {
  id: string;
  indexed: "fresh" | "expired" | "never";
}

/** IDs of the videos whose state is "never" or "expired", in list order. */
export function selectAllNeedingIndex(videos: IndexableVideo[]): string[] {
  return videos
    .filter((video) => video.indexed === "never" || video.indexed === "expired")
    .map((video) => video.id);
}

/** IDs of every video, whatever its state, in list order. */
export function selectAllLoaded(videos: IndexableVideo[]): string[] {
  return videos.map((video) => video.id);
}

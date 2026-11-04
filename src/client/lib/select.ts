// Video selection helpers for the creator archive page: "select all"
// picks every loaded video that still needs indexing. The server takes at
// most 200 IDs per request, so the caller batches the result. Unit tested
// in select.test.ts.

/** The fields selectAllNeedingIndex reads from each video entry. */
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

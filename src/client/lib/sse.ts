// Pure SSE parsing for the quote-stream endpoint: split the decoded text
// stream into event blocks. Unit tested in sse.test.ts.

export interface SseEvent {
  event: string;
  data: string;
}

/** Parse one raw block (no trailing blank line) into an event, or null. */
export function parseSseBlock(block: string): SseEvent | null {
  let event = "";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).replace(/^ /, "");
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }
  if (!event) return null;
  return { event, data: dataLines.join("\n") };
}

/** Incremental parser: feed decoded chunks, get complete events back. */
export function createSseParser(): { feed(chunk: string): SseEvent[] } {
  let buffer = "";
  return {
    feed(chunk: string): SseEvent[] {
      buffer += chunk.replace(/\r\n/g, "\n");
      const events: SseEvent[] = [];
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const parsed = parseSseBlock(buffer.slice(0, end));
        if (parsed) events.push(parsed);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");
      }
      return events;
    },
  };
}

import { describe, expect, it } from "vitest";
import { createSseParser, parseSseBlock } from "./sse";

describe("parseSseBlock", () => {
  it("parses an event and data line", () => {
    expect(
      parseSseBlock('event: progress\ndata: {"stage":"Indexing"}'),
    ).toEqual({ event: "progress", data: '{"stage":"Indexing"}' });
  });

  it("returns null when the event line is missing", () => {
    expect(parseSseBlock('data: {"a":1}')).toBeNull();
  });

  it("ignores comment lines", () => {
    expect(
      parseSseBlock(": heartbeat\nevent: progress\ndata: {}"),
    ).toEqual({ event: "progress", data: "{}" });
  });

  it("joins multi-line data with newlines", () => {
    expect(parseSseBlock("event: x\ndata: one\ndata: two")).toEqual({
      event: "x",
      data: "one\ntwo",
    });
  });
});

describe("createSseParser", () => {
  it("emits one event per blank-line block", () => {
    const parser = createSseParser();
    expect(
      parser.feed(
        'event: progress\ndata: {"a":1}\n\nevent: result\ndata: {"b":2}\n\n',
      ),
    ).toEqual([
      { event: "progress", data: '{"a":1}' },
      { event: "result", data: '{"b":2}' },
    ]);
  });

  it("buffers a partial block across feeds", () => {
    const parser = createSseParser();
    expect(parser.feed("event: prog")).toEqual([]);
    expect(parser.feed('ress\ndata: {"a":1}\n\n')).toEqual([
      { event: "progress", data: '{"a":1}' },
    ]);
  });

  it("keeps a trailing partial block for the next feed", () => {
    const parser = createSseParser();
    expect(
      parser.feed('event: progress\ndata: {"a":1}\n\nevent: res'),
    ).toEqual([{ event: "progress", data: '{"a":1}' }]);
    expect(parser.feed('ult\ndata: {"b":2}\n\n')).toEqual([
      { event: "result", data: '{"b":2}' },
    ]);
  });

  it("normalizes CRLF line endings", () => {
    const parser = createSseParser();
    expect(parser.feed("event: progress\r\ndata: {}\r\n\r\n")).toEqual([
      { event: "progress", data: "{}" },
    ]);
  });

  it("skips blocks without an event line", () => {
    const parser = createSseParser();
    expect(parser.feed(": ping\n\n\nevent: result\ndata: {}\n\n")).toEqual([
      { event: "result", data: "{}" },
    ]);
  });
});

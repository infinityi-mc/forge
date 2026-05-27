import { describe, expect, test } from "bun:test";
import { createLog } from "../../../../src/telemetry/log";
import {
  formatJson,
  formatPretty,
  stdoutExporter,
} from "../../../../src/telemetry/log/exporters/stdout";
import { withRootContext } from "../../../../src/telemetry/context";

function captureStreams() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    streams: {
      stdout: {
        write: (chunk: string) => {
          stdout.push(chunk);
          return true;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr.push(chunk);
          return true;
        },
      },
    },
  };
}

describe("formatJson", () => {
  test("hoists attributes to top-level and adds time/level/msg framing", () => {
    const line = formatJson({
      level: "info",
      message: "hi",
      timestamp: new Date("2025-01-01T00:00:00.000Z"),
      attributes: { method: "GET", path: "/" },
    });
    const parsed = JSON.parse(line);
    expect(parsed.time).toBe("2025-01-01T00:00:00.000Z");
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hi");
    expect(parsed.method).toBe("GET");
    expect(parsed.path).toBe("/");
  });

  test("includes trace_id and span_id when context is attached", () => {
    const line = formatJson({
      level: "info",
      message: "hi",
      timestamp: new Date(0),
      attributes: {},
      context: {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        traceFlags: 1,
        baggage: {},
      },
    });
    const parsed = JSON.parse(line);
    expect(parsed.trace_id).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(parsed.span_id).toBe("b7ad6b7169203331");
  });

  test("attributes never overwrite framing keys", () => {
    const line = formatJson({
      level: "info",
      message: "hi",
      timestamp: new Date(0),
      attributes: { time: "lol", msg: "evil" },
    });
    const parsed = JSON.parse(line);
    expect(parsed.msg).toBe("hi");
    expect(parsed.time).not.toBe("lol");
  });

  test("epoch timestamp format emits a number", () => {
    const line = formatJson(
      {
        level: "info",
        message: "x",
        timestamp: new Date(123),
        attributes: {},
      },
      { timestampFormat: "epoch" },
    );
    expect(JSON.parse(line).time).toBe(123);
  });

  test("safeStringify breaks cycles in attribute values", () => {
    const obj: Record<string, unknown> = { name: "root" };
    obj["self"] = obj;
    const line = formatJson({
      level: "info",
      message: "x",
      timestamp: new Date(0),
      attributes: { cyc: obj },
    });
    expect(line).toContain("[circular]");
    expect(() => JSON.parse(line)).not.toThrow();
  });

  test("safeStringify coerces BigInt values to strings", () => {
    const line = formatJson({
      level: "info",
      message: "x",
      timestamp: new Date(0),
      attributes: { big: 9007199254740993n },
    });
    const parsed = JSON.parse(line);
    expect(parsed.big).toBe("9007199254740993");
  });

  test("safeStringify returns a placeholder when an attribute's toJSON throws", () => {
    const evil = {
      toJSON() {
        throw new Error("nope");
      },
    };
    const line = formatJson({
      level: "info",
      message: "x",
      timestamp: new Date(0),
      attributes: { evil },
    });
    expect(line).toContain("_serialization_error");
    expect(() => JSON.parse(line)).not.toThrow();
  });
});

describe("formatPretty", () => {
  test("produces a single line with time, level, message", () => {
    const line = formatPretty({
      level: "info",
      message: "served",
      timestamp: new Date(Date.UTC(2025, 0, 1, 12, 34, 56, 789)),
      attributes: { code: 200 },
    });
    expect(line.endsWith("\n")).toBe(true);
    expect(line).toContain("INFO");
    expect(line).toContain("served");
    expect(line).toContain("code=200");
  });

  test("strings containing whitespace are quoted", () => {
    const line = formatPretty({
      level: "info",
      message: "m",
      timestamp: new Date(0),
      attributes: { k: "a b" },
    });
    expect(line).toContain('k="a b"');
  });
});

describe("stdoutExporter", () => {
  test("uses JSON when stdout is not a TTY", () => {
    const cap = captureStreams();
    const log = createLog({ exporter: stdoutExporter(cap.streams) });
    log.info("hello", { k: 1 });
    expect(cap.stdout).toHaveLength(1);
    const parsed = JSON.parse(cap.stdout[0]!);
    expect(parsed.msg).toBe("hello");
  });

  test("routes warn/error/fatal to stderr by default", () => {
    const cap = captureStreams();
    const log = createLog({
      exporter: stdoutExporter(cap.streams),
      level: "trace",
    });

    log.trace("t");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    log.fatal("f");

    expect(cap.stdout).toHaveLength(3);
    expect(cap.stderr).toHaveLength(3);
  });

  test("can be forced to pretty format", () => {
    const cap = captureStreams();
    const log = createLog({
      exporter: stdoutExporter({
        format: "pretty",
        color: false,
        ...cap.streams,
      }),
    });
    log.info("served", { code: 200 });
    expect(cap.stdout[0]).toContain("INFO");
    expect(cap.stdout[0]).toContain("served");
  });

  test("includes trace_id from active context", () => {
    const cap = captureStreams();
    const log = createLog({ exporter: stdoutExporter(cap.streams) });
    withRootContext({}, () => {
      log.info("hi");
    });
    const parsed = JSON.parse(cap.stdout[0]!);
    expect(parsed.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });

  test("splitStreams=false sends everything to stdout", () => {
    const cap = captureStreams();
    const log = createLog({
      exporter: stdoutExporter({ splitStreams: false, ...cap.streams }),
    });
    log.error("boom");
    expect(cap.stderr).toHaveLength(0);
    expect(cap.stdout).toHaveLength(1);
  });
});

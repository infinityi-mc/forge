import { describe, expect, test } from "bun:test";
import { createLog } from "../../../../src/telemetry/log";
import { serialize } from "../../../../src/telemetry/log/middleware";
import { recordingExporter } from "../../../../src/telemetry/log/exporters/recording";

describe("serialize middleware", () => {
  test("recursively converts Errors when no errorKeys are specified", () => {
    const exp = recordingExporter();
    const log = createLog({ exporter: exp, middleware: [serialize()] });

    log.error("boom", {
      err: new TypeError("bad"),
      ctx: { nested: new Error("inside") },
    });

    const attrs = exp.records[0]!.attributes as Record<string, unknown>;
    expect((attrs["err"] as Record<string, unknown>)["name"]).toBe("TypeError");
    expect(
      ((attrs["ctx"] as Record<string, unknown>)["nested"] as Record<string, unknown>)["message"],
    ).toBe("inside");
  });

  test("when errorKeys is set, only listed paths are serialized", () => {
    const exp = recordingExporter();
    const log = createLog({
      exporter: exp,
      middleware: [serialize({ errorKeys: ["only"] })],
    });

    const skipped = new Error("not-serialized");
    log.error("m", { only: new Error("yes"), skip: skipped });

    const attrs = exp.records[0]!.attributes as Record<string, unknown>;
    expect((attrs["only"] as Record<string, unknown>)["message"]).toBe("yes");
    expect(attrs["skip"]).toBe(skipped);
  });

  test("preserves Date and primitive values verbatim", () => {
    const exp = recordingExporter();
    const log = createLog({ exporter: exp, middleware: [serialize()] });
    const when = new Date(0);
    log.info("m", { when, n: 1, b: true, s: "x" });

    const attrs = exp.records[0]!.attributes;
    expect(attrs["when"]).toBe(when);
    expect(attrs["n"]).toBe(1);
    expect(attrs["b"]).toBe(true);
    expect(attrs["s"]).toBe("x");
  });

  test("handles circular structures via [circular]", () => {
    const exp = recordingExporter();
    const log = createLog({ exporter: exp, middleware: [serialize()] });

    const obj: Record<string, unknown> = { self: null };
    obj["self"] = obj;
    log.info("m", { obj });

    expect(JSON.stringify(exp.records[0]!.attributes)).toContain("[circular]");
  });
});

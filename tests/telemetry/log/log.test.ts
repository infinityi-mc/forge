import { describe, expect, test } from "bun:test";
import { createLog } from "../../../src/telemetry/log";
import { recordingExporter } from "../../../src/telemetry/log/exporters/recording";
import { withRootContext } from "../../../src/telemetry/context";

describe("createLog", () => {
  test("emits a record with level, message, timestamp, and empty attributes by default", () => {
    const exp = recordingExporter();
    const log = createLog({ exporter: exp });

    log.info("hello");

    expect(exp.records).toHaveLength(1);
    const record = exp.records[0]!;
    expect(record.level).toBe("info");
    expect(record.message).toBe("hello");
    expect(record.attributes).toEqual({});
    expect(record.timestamp).toBeInstanceOf(Date);
    expect(record.context).toBeUndefined();
  });

  test("default level is 'info' — debug suppressed, info emitted", () => {
    const exp = recordingExporter();
    const log = createLog({ exporter: exp });

    log.debug("noisy");
    log.info("ok");

    expect(exp.records).toHaveLength(1);
    expect(exp.records[0]!.message).toBe("ok");
  });

  test("emits all six standard levels when set to 'trace'", () => {
    const exp = recordingExporter();
    const log = createLog({ exporter: exp, level: "trace" });

    log.trace("t");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    log.fatal("f");

    expect(exp.records.map((r) => r.level)).toEqual([
      "trace",
      "debug",
      "info",
      "warn",
      "error",
      "fatal",
    ]);
  });

  test("merges base attributes with per-call attributes; per-call wins on conflict", () => {
    const exp = recordingExporter();
    const log = createLog({
      exporter: exp,
      attributes: { service: "auth", env: "dev" },
    });

    log.info("ok", { env: "prod", userId: "1" });

    expect(exp.records[0]!.attributes).toEqual({
      service: "auth",
      env: "prod",
      userId: "1",
    });
  });

  test("child logger merges parent attributes with child attributes", () => {
    const exp = recordingExporter();
    const log = createLog({
      exporter: exp,
      attributes: { service: "auth" },
    });
    const child = log.child({ subsystem: "session" });

    child.info("hi", { userId: "1" });

    expect(exp.records[0]!.attributes).toEqual({
      service: "auth",
      subsystem: "session",
      userId: "1",
    });
  });

  test("child logger inherits the level of its parent", () => {
    const exp = recordingExporter();
    const log = createLog({ exporter: exp, level: "warn" });
    const child = log.child({ subsystem: "x" });

    child.info("filtered out");
    child.warn("emitted");

    expect(exp.records).toHaveLength(1);
    expect(exp.records[0]!.message).toBe("emitted");
  });

  test("auto-injects the active TelemetryContext", () => {
    const exp = recordingExporter();
    const log = createLog({ exporter: exp });

    withRootContext({}, () => {
      log.info("inside");
    });
    log.info("outside");

    expect(exp.records).toHaveLength(2);
    expect(exp.records[0]!.context).toBeDefined();
    expect(exp.records[0]!.context!.traceId).toHaveLength(32);
    expect(exp.records[1]!.context).toBeUndefined();
  });

  test("isolates exporter failures by default", () => {
    const exp = recordingExporter({
      failNextWith: () => new Error("kaboom"),
    });
    const log = createLog({ exporter: exp });

    // Should not throw despite exporter raising.
    expect(() => log.info("first")).not.toThrow();
    // Second call should succeed normally.
    log.info("second");
    expect(exp.records).toHaveLength(1);
    expect(exp.records[0]!.message).toBe("second");
  });

  test("propagates exporter failures when propagateExporterErrors=true", () => {
    const exp = recordingExporter({
      failNextWith: () => new Error("kaboom"),
    });
    const log = createLog({ exporter: exp, propagateExporterErrors: true });

    expect(() => log.info("first")).toThrow("kaboom");
  });

  test("flush() resolves immediately when exporter has no flush method", async () => {
    const exporter = { export: () => {} };
    const log = createLog({ exporter });
    await log.flush?.();
  });

  test("flush() delegates to the exporter", async () => {
    let flushed = 0;
    const exporter = {
      export: () => {},
      flush: async () => {
        flushed++;
      },
    };
    const log = createLog({ exporter });
    await log.flush?.();
    expect(flushed).toBe(1);
  });
});

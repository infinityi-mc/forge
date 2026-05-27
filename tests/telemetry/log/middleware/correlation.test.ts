import { describe, expect, test } from "bun:test";
import { createLog } from "../../../../src/telemetry/log";
import { correlation } from "../../../../src/telemetry/log/middleware";
import { recordingExporter } from "../../../../src/telemetry/log/exporters/recording";
import { withRootContext } from "../../../../src/telemetry/context";

describe("correlation middleware", () => {
  test("copies baggage onto attributes when context is active", () => {
    const exp = recordingExporter();
    const log = createLog({ exporter: exp, middleware: [correlation()] });

    withRootContext({ baggage: { tenantId: "acme", userId: "u1" } }, () => {
      log.info("hi");
    });

    expect(exp.records[0]!.attributes["tenantId"]).toBe("acme");
    expect(exp.records[0]!.attributes["userId"]).toBe("u1");
  });

  test("adds trace_id and span_id when includeTraceIds=true (default)", () => {
    const exp = recordingExporter();
    const log = createLog({ exporter: exp, middleware: [correlation()] });

    withRootContext({}, () => {
      log.info("hi");
    });

    expect(exp.records[0]!.attributes["trace_id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(exp.records[0]!.attributes["span_id"]).toMatch(/^[0-9a-f]{16}$/);
  });

  test("opts out of trace id injection when includeTraceIds=false", () => {
    const exp = recordingExporter();
    const log = createLog({
      exporter: exp,
      middleware: [correlation({ includeTraceIds: false })],
    });

    withRootContext({ baggage: { k: "v" } }, () => {
      log.info("hi");
    });

    expect(exp.records[0]!.attributes["trace_id"]).toBeUndefined();
    expect(exp.records[0]!.attributes["k"]).toBe("v");
  });

  test("restricts copied baggage keys when keys[] is provided", () => {
    const exp = recordingExporter();
    const log = createLog({
      exporter: exp,
      middleware: [correlation({ keys: ["tenantId"], includeTraceIds: false })],
    });

    withRootContext({ baggage: { tenantId: "acme", userId: "u1" } }, () => {
      log.info("hi");
    });

    expect(exp.records[0]!.attributes["tenantId"]).toBe("acme");
    expect(exp.records[0]!.attributes["userId"]).toBeUndefined();
  });

  test("per-call attributes win over baggage on key conflict", () => {
    const exp = recordingExporter();
    const log = createLog({
      exporter: exp,
      middleware: [correlation({ includeTraceIds: false })],
    });

    withRootContext({ baggage: { service: "from-baggage" } }, () => {
      log.info("hi", { service: "from-call" });
    });

    expect(exp.records[0]!.attributes["service"]).toBe("from-call");
  });

  test("is a no-op outside any context", () => {
    const exp = recordingExporter();
    const log = createLog({ exporter: exp, middleware: [correlation()] });
    log.info("hi");
    expect(exp.records[0]!.attributes).toEqual({});
  });
});

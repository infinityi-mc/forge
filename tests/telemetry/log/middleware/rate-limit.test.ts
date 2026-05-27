import { describe, expect, test } from "bun:test";
import { createLog } from "../../../../src/telemetry/log";
import { rateLimit, telemetry } from "../../../../src/telemetry/log/middleware";
import { LogRateLimitError } from "../../../../src/telemetry/log/errors";
import { recordingExporter } from "../../../../src/telemetry/log/exporters/recording";

describe("rateLimit middleware", () => {
  test("allows burst and then drops excess (whenExceeded='drop')", () => {
    const exp = recordingExporter();
    let nowMs = 0;
    const log = createLog({
      exporter: exp,
      middleware: [
        rateLimit({
          recordsPerInterval: 1,
          intervalMs: 1_000,
          burst: 3,
          now: () => nowMs,
        }),
      ],
    });
    for (let i = 0; i < 10; i++) log.info("m");
    expect(exp.records).toHaveLength(3);
  });

  test("refills tokens over time", () => {
    const exp = recordingExporter();
    let nowMs = 0;
    const log = createLog({
      exporter: exp,
      middleware: [
        rateLimit({
          recordsPerInterval: 10,
          intervalMs: 1_000,
          burst: 1,
          now: () => nowMs,
        }),
      ],
    });
    log.info("a"); // 1 token used
    log.info("b"); // dropped, no tokens
    nowMs += 100;   // refill 100ms × 10/1000 = 1 token
    log.info("c"); // ok
    expect(exp.records.map((r) => r.message)).toEqual(["a", "c"]);
  });

  test("throws LogRateLimitError when whenExceeded='throw'", () => {
    const exp = recordingExporter();
    let nowMs = 0;
    const log = createLog({
      exporter: exp,
      propagateExporterErrors: true,
      middleware: [
        rateLimit({
          recordsPerInterval: 1,
          intervalMs: 1_000,
          burst: 1,
          whenExceeded: "throw",
          now: () => nowMs,
        }),
      ],
    });

    log.info("first"); // ok
    expect(() => log.info("second")).toThrow(LogRateLimitError);
  });

  test("notifies telemetry middleware about drops", () => {
    const drops: unknown[] = [];
    let nowMs = 0;
    const exp = recordingExporter();
    const log = createLog({
      exporter: exp,
      middleware: [
        rateLimit({
          recordsPerInterval: 1,
          intervalMs: 1_000,
          burst: 1,
          now: () => nowMs,
        }),
        telemetry({ onDrop: (notice) => drops.push(notice) }),
      ],
    });
    log.info("a");
    log.info("b");
    expect(drops).toHaveLength(1);
    expect((drops[0] as { reason: string }).reason).toBe("rate-limit");
  });

  test("rejects invalid options at construction", () => {
    expect(() => rateLimit({ recordsPerInterval: 0 })).toThrow();
    expect(() =>
      rateLimit({ recordsPerInterval: 1, intervalMs: 0 }),
    ).toThrow();
    expect(() =>
      rateLimit({ recordsPerInterval: 1, burst: 0 }),
    ).toThrow();
  });
});

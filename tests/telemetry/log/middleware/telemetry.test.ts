import { describe, expect, test } from "bun:test";
import { createLog } from "../../../../src/telemetry/log";
import {
  rateLimit,
  sample,
  telemetry,
} from "../../../../src/telemetry/log/middleware";
import { recordingExporter } from "../../../../src/telemetry/log/exporters/recording";

describe("telemetry middleware", () => {
  test("invokes onWrite for every successful write", () => {
    const exp = recordingExporter();
    const writes: unknown[] = [];
    const log = createLog({
      exporter: exp,
      middleware: [telemetry({ onWrite: (info) => writes.push(info) })],
    });

    log.info("a");
    log.info("b");

    expect(writes).toHaveLength(2);
  });

  test("invokes onDrop when a downstream middleware drops the record", () => {
    const exp = recordingExporter();
    const drops: unknown[] = [];
    const log = createLog({
      exporter: exp,
      middleware: [
        sample({ rate: 0 }), // drops everything
        telemetry({ onDrop: (notice) => drops.push(notice) }),
      ],
    });

    log.info("a");
    expect(drops).toHaveLength(1);
    expect((drops[0] as { reason: string }).reason).toBe("sample");
  });

  test("invokes onError when the exporter throws — marking it handled so the logger does not double-report", () => {
    const errors: unknown[] = [];
    const exp = recordingExporter({
      failNextWith: () => new Error("boom"),
    });
    const log = createLog({
      exporter: exp,
      middleware: [telemetry({ onError: (info) => errors.push(info) })],
    });

    log.info("a"); // exporter throws; middleware should observe and not crash
    expect(errors).toHaveLength(1);
  });

  test("hook failures never alter logger control flow", () => {
    const exp = recordingExporter();
    const log = createLog({
      exporter: exp,
      middleware: [
        telemetry({
          onWrite: () => {
            throw new Error("hook failed");
          },
        }),
      ],
    });

    // Logger should swallow the hook failure and still record.
    expect(() => log.info("a")).not.toThrow();
    expect(exp.records).toHaveLength(1);
  });

  test("combined with rateLimit, drop notices include retryAfterMs metadata", () => {
    const drops: { reason: string; metadata?: Record<string, unknown> }[] = [];
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
    expect(drops[0]!.metadata).toHaveProperty("retryAfterMs");
  });

  test("hooks propagate through intermediate middleware (README order: [sample, rateLimit, telemetry])", () => {
    const drops: { reason: string }[] = [];
    let nowMs = 0;
    const exp = recordingExporter();
    const log = createLog({
      exporter: exp,
      level: "trace",
      middleware: [
        // sample drops everything — its next is the rateLimit wrapper,
        // which does NOT define LOG_DROP_HOOK locally. The fix in
        // applyMiddleware/forwardHooks must surface the telemetry hook
        // through the rateLimit wrapper for this notice to land.
        sample({ rate: 0 }),
        rateLimit({
          recordsPerInterval: 1000,
          intervalMs: 1_000,
          burst: 1000,
          now: () => nowMs,
        }),
        telemetry({ onDrop: (notice) => drops.push(notice) }),
      ],
    });

    log.info("a");
    log.info("b");
    log.info("c");

    expect(drops).toHaveLength(3);
    expect(drops.every((d) => d.reason === "sample")).toBe(true);
  });
});

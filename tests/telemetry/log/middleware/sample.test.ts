import { describe, expect, test } from "bun:test";
import { createLog } from "../../../../src/telemetry/log";
import { sample } from "../../../../src/telemetry/log/middleware";
import { recordingExporter } from "../../../../src/telemetry/log/exporters/recording";

describe("sample middleware", () => {
  test("rate=1 keeps every record", () => {
    const exp = recordingExporter();
    const log = createLog({ exporter: exp, middleware: [sample({ rate: 1 })] });
    for (let i = 0; i < 10; i++) log.info("m");
    expect(exp.records).toHaveLength(10);
  });

  test("rate=0 drops every record", () => {
    const exp = recordingExporter();
    const log = createLog({ exporter: exp, middleware: [sample({ rate: 0 })] });
    for (let i = 0; i < 10; i++) log.info("m");
    expect(exp.records).toHaveLength(0);
  });

  test("perSeverity overrides the global rate", () => {
    const exp = recordingExporter();
    const log = createLog({
      exporter: exp,
      level: "trace",
      middleware: [sample({ rate: 0, perSeverity: { error: 1 } })],
    });
    log.info("dropped");
    log.error("kept");
    expect(exp.records).toHaveLength(1);
    expect(exp.records[0]!.level).toBe("error");
  });

  test("random=true uses the supplied randomSource", () => {
    const exp = recordingExporter();
    const values = [0.0, 0.5, 0.99];
    let i = 0;
    const log = createLog({
      exporter: exp,
      middleware: [
        sample({
          rate: 0.6,
          random: true,
          randomSource: () => values[i++ % values.length]!,
        }),
      ],
    });
    log.info("a"); // 0.0  < 0.6 → keep
    log.info("b"); // 0.5  < 0.6 → keep
    log.info("c"); // 0.99 ≥ 0.6 → drop
    expect(exp.records).toHaveLength(2);
  });

  test("rejects rates outside [0,1]", () => {
    expect(() => sample({ rate: -0.1 })).toThrow();
    expect(() => sample({ rate: 1.1 })).toThrow();
    expect(() => sample({ bucketMs: 0 })).toThrow();
  });
});

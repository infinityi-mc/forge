import { describe, expect, test } from "bun:test";
import { createLog } from "../../../../src/telemetry/log";
import { redact } from "../../../../src/telemetry/log/middleware";
import { recordingExporter } from "../../../../src/telemetry/log/exporters/recording";

describe("redact middleware", () => {
  test("replaces values at the configured dotted paths", () => {
    const exp = recordingExporter();
    const log = createLog({
      exporter: exp,
      middleware: [redact({ paths: ["user.password"] })],
    });

    log.info("login", { user: { id: 1, password: "shh" } });

    const attrs = exp.records[0]!.attributes as Record<
      string,
      Record<string, unknown>
    >;
    expect(attrs["user"]!["password"]).toBe("[REDACTED]");
    expect(attrs["user"]!["id"]).toBe(1);
  });

  test("applies regex patterns to attribute strings and the message", () => {
    const exp = recordingExporter();
    const log = createLog({
      exporter: exp,
      middleware: [redact({ patterns: [/Bearer\s+\S+/g] })],
    });

    log.warn("Authorization: Bearer abc123", { hdr: "Bearer xyz" });

    expect(exp.records[0]!.message).toBe("Authorization: [REDACTED]");
    expect(exp.records[0]!.attributes["hdr"]).toBe("[REDACTED]");
  });

  test("respects custom replacement strings", () => {
    const exp = recordingExporter();
    const log = createLog({
      exporter: exp,
      middleware: [redact({ paths: ["k"], replacement: "**" })],
    });
    log.info("m", { k: "secret" });
    expect(exp.records[0]!.attributes["k"]).toBe("**");
  });

  test("does not mutate the input attributes object", () => {
    const exp = recordingExporter();
    const log = createLog({
      exporter: exp,
      middleware: [redact({ paths: ["k"] })],
    });
    const attrs = { k: "secret" };
    log.info("m", attrs);
    expect(attrs.k).toBe("secret");
  });

  test("handles circular structures without infinite recursion", () => {
    const exp = recordingExporter();
    const log = createLog({
      exporter: exp,
      middleware: [redact({ patterns: [/secret/] })],
    });
    const obj: Record<string, unknown> = { ref: null };
    obj["ref"] = obj;
    log.info("m", { x: obj });
    expect(exp.records).toHaveLength(1);
  });
});

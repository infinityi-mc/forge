import { describe, expect, test } from "bun:test";
import { TelemetryError } from "../../../src/telemetry/errors";
import {
  LogAbortError,
  LogError,
  LogExporterError,
  LogRateLimitError,
  LogSerializationError,
} from "../../../src/telemetry/log/errors";

describe("error taxonomy", () => {
  test("every log error is a LogError", () => {
    expect(new LogExporterError("x")).toBeInstanceOf(LogError);
    expect(new LogSerializationError("x")).toBeInstanceOf(LogError);
    expect(new LogRateLimitError("x", { retryAfterMs: 0 })).toBeInstanceOf(
      LogError,
    );
    expect(new LogAbortError()).toBeInstanceOf(LogError);
  });

  test("every log error inherits TelemetryError so one catch handles all signals", () => {
    expect(new LogError("x")).toBeInstanceOf(TelemetryError);
  });

  test("LogExporterError preserves the offending record", () => {
    const record = {
      level: "info" as const,
      message: "m",
      timestamp: new Date(),
      attributes: {},
    };
    const err = new LogExporterError("boom", { record });
    expect(err.record).toBe(record);
  });

  test("LogRateLimitError exposes retryAfterMs", () => {
    const err = new LogRateLimitError("nope", { retryAfterMs: 250 });
    expect(err.retryAfterMs).toBe(250);
  });

  test("LogSerializationError carries path when supplied", () => {
    const err = new LogSerializationError("bad", { path: "user.token" });
    expect(err.path).toBe("user.token");
  });

  test("error name is set on every class", () => {
    expect(new LogError("x").name).toBe("LogError");
    expect(new LogExporterError("x").name).toBe("LogExporterError");
    expect(new LogSerializationError("x").name).toBe("LogSerializationError");
    expect(new LogRateLimitError("x", { retryAfterMs: 0 }).name).toBe(
      "LogRateLimitError",
    );
    expect(new LogAbortError().name).toBe("LogAbortError");
  });
});

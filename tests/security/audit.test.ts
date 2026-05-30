import { describe, expect, test } from "bun:test";
import {
  auditPrincipal,
  createAuditRecorder,
  memoryAuditSink,
} from "../../src/security/audit";
import { fakePrincipal } from "../../src/security/testing";

describe("security audit", () => {
  test("recorder fills deterministic id and timestamp", async () => {
    const sink = memoryAuditSink();
    const recorder = createAuditRecorder({
      sink,
      clock: { now: () => 1_700_000_000_000 },
      idGenerator: () => "audit_1",
    });

    await recorder.record({
      type: "authentication/success",
      outcome: "success",
      action: "login",
    });

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      id: "audit_1",
      timestamp: new Date(1_700_000_000_000),
      type: "authentication/success",
      outcome: "success",
      action: "login",
    });
  });

  test("memory sink records and clears events", async () => {
    const sink = memoryAuditSink();
    const recorder = createAuditRecorder({
      sink,
      idGenerator: () => "audit_2",
    });

    await recorder.record({
      type: "authorization/allow",
      outcome: "allow",
    });
    expect(sink.events).toHaveLength(1);

    sink.clear();
    expect(sink.events).toHaveLength(0);
  });

  test("principal summaries exclude claims and token material", () => {
    const principal = fakePrincipal({
      roles: ["admin"],
      scopes: ["reports:read"],
      tenant: "tenant_1",
      claims: {
        api_key: "raw-secret",
        token: "raw-token",
      },
    });

    const summary = auditPrincipal(principal);

    expect(summary).toEqual({
      subject: "user_1",
      issuer: "https://issuer.test",
      tenant: "tenant_1",
      roles: ["admin"],
      scopes: ["reports:read"],
    });
    expect("claims" in summary).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("raw-secret");
    expect(JSON.stringify(summary)).not.toContain("raw-token");
  });

  test("sink throws are isolated and logged", async () => {
    const warnings: unknown[] = [];
    const recorder = createAuditRecorder({
      sink: {
        record() {
          throw new Error("disk full");
        },
      },
      logger: {
        warn(message, attributes) {
          warnings.push({ message, attributes });
        },
      },
    });

    await expect(
      recorder.record({
        type: "authentication/failure",
        outcome: "failure",
      }),
    ).resolves.toBeUndefined();
    expect(warnings).toEqual([
      {
        message: "security audit recording failed",
        attributes: { reason: "disk full" },
      },
    ]);
  });
});

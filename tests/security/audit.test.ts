import { describe, expect, test } from "bun:test";
import {
  auditPrincipal,
  createAuditLogger,
  hashAuditEvent,
  logSink,
  memorySink,
  verifyAuditChain,
} from "../../src/security/audit";
import type { AuditEvent } from "../../src/security/audit";
import { AuditError } from "../../src/security/errors";
import { Secret } from "../../src/config/secret";
import { fakePrincipal } from "../../src/security/testing";

describe("security audit", () => {
  test("logger fills `at` from the clock and forwards core fields", async () => {
    const sink = memorySink();
    const logger = createAuditLogger({
      sink,
      clock: { now: () => 1_700_000_000_000 },
    });

    await logger.record({
      action: "auth.token.verified",
      outcome: "success",
      principal: { subject: "user_1", issuer: "https://issuer.test" },
    });

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      action: "auth.token.verified",
      outcome: "success",
      at: new Date(1_700_000_000_000),
      principal: { subject: "user_1", issuer: "https://issuer.test" },
    });
    expect("hash" in sink.events[0]!).toBe(false);
  });

  test("correlation id is pulled from the provider when absent on input", async () => {
    const sink = memorySink();
    const logger = createAuditLogger({
      sink,
      correlation: () => "trace-123",
    });

    await logger.record({ action: "authz.allowed", outcome: "success" });
    await logger.record({
      action: "authz.denied",
      outcome: "denied",
      correlationId: "explicit-9",
    });

    expect(sink.events[0]?.correlationId).toBe("trace-123");
    expect(sink.events[1]?.correlationId).toBe("explicit-9");
  });

  test("redact replaces values at the configured metadata paths", async () => {
    const sink = memorySink();
    const logger = createAuditLogger({
      sink,
      redact: ["headers.authorization", "secret"],
    });

    await logger.record({
      action: "auth.token.verified",
      outcome: "success",
      metadata: {
        secret: "raw-token",
        headers: { authorization: "Bearer raw-token", "x-id": "keep" },
      },
    });

    expect(sink.events[0]?.metadata).toEqual({
      secret: "[REDACTED]",
      headers: { authorization: "[REDACTED]", "x-id": "keep" },
    });
    expect(JSON.stringify(sink.events[0])).not.toContain("raw-token");
  });

  test("tamperEvident chains records and verifyAuditChain detects edits", async () => {
    const sink = memorySink();
    const logger = createAuditLogger({ sink, tamperEvident: true });

    await logger.record({ action: "auth.token.verified", outcome: "success" });
    await logger.record({ action: "authz.allowed", outcome: "success" });

    expect(sink.events[0]?.hash).toBeDefined();
    expect(sink.events[1]?.previousHash).toBe(sink.events[0]?.hash);
    expect(await verifyAuditChain(sink.events)).toBe(true);

    const tampered = [
      { ...sink.events[0]!, outcome: "failure" as const },
      sink.events[1]!,
    ];
    expect(await verifyAuditChain(tampered)).toBe(false);
  });

  test("plain hash chain re-verifies after a full rewrite (consistency only)", async () => {
    const sink = memorySink();
    const logger = createAuditLogger({ sink, tamperEvident: true });
    await logger.record({ action: "auth.token.verified", outcome: "success" });

    // An attacker who rewrites the whole store recomputes the chain; plain
    // hashing cannot detect this — it only proves internal consistency.
    const original = sink.events[0]!;
    const forged: AuditEvent = { ...original, outcome: "failure" };
    const { hash: _h, ...rest } = forged;
    const recomputed = await hashAuditEvent(rest as AuditEvent);
    expect(
      await verifyAuditChain([{ ...rest, hash: recomputed } as AuditEvent]),
    ).toBe(true);
  });

  test("signingSecret requires tamperEvident logging", () => {
    expect(() =>
      createAuditLogger({
        sink: memorySink(),
        signingSecret: new Secret("audit-signing-key"),
      }),
    ).toThrow(AuditError);
  });

  test("HMAC-signed chain rejects rewritten events without the secret", async () => {
    const secret = new Secret("audit-signing-key");
    const sink = memorySink();
    const logger = createAuditLogger({
      sink,
      tamperEvident: true,
      signingSecret: secret,
    });
    await logger.record({ action: "auth.token.verified", outcome: "success" });
    await logger.record({ action: "authz.allowed", outcome: "success" });

    // Verifies only with the secret.
    expect(await verifyAuditChain(sink.events, { secret })).toBe(true);
    expect(await verifyAuditChain(sink.events)).toBe(false);

    // An attacker recomputes hashes with plain SHA-256 (no secret) — rejected.
    const forged: AuditEvent = { ...sink.events[0]!, outcome: "failure" };
    const { hash: _h, ...rest } = forged;
    const plainHash = await hashAuditEvent(rest as AuditEvent);
    expect(
      await verifyAuditChain([{ ...rest, hash: plainHash } as AuditEvent], {
        secret,
      }),
    ).toBe(false);
  });

  test("expectedHead checkpoint fails verification on mismatch", async () => {
    const sink = memorySink();
    const logger = createAuditLogger({ sink, tamperEvident: true });
    await logger.record({ action: "auth.token.verified", outcome: "success" });
    const head = sink.events[0]!.hash!;

    expect(await verifyAuditChain(sink.events, { expectedHead: head })).toBe(
      true,
    );
    expect(
      await verifyAuditChain(sink.events, { expectedHead: "not-the-head" }),
    ).toBe(false);
  });

  test("records serialize across concurrent callers deterministically", async () => {
    const sink = memorySink();
    const logger = createAuditLogger({ sink, tamperEvident: true });

    await Promise.all([
      logger.record({ action: "a", outcome: "success" }),
      logger.record({ action: "b", outcome: "success" }),
      logger.record({ action: "c", outcome: "success" }),
    ]);

    expect(sink.events).toHaveLength(3);
    expect(await verifyAuditChain(sink.events)).toBe(true);
  });

  test("memory sink records and clears events", async () => {
    const sink = memorySink();
    const logger = createAuditLogger({ sink });

    await logger.record({ action: "authz.allowed", outcome: "success" });
    expect(sink.events).toHaveLength(1);

    sink.clear();
    expect(sink.events).toHaveLength(0);
  });

  test("logSink routes successes to info and everything else to warn", async () => {
    const calls: Array<{ level: string; message: string }> = [];
    const logger = createAuditLogger({
      sink: logSink({
        logger: {
          info: (message) => calls.push({ level: "info", message }),
          warn: (message) => calls.push({ level: "warn", message }),
        },
      }),
    });

    await logger.record({ action: "auth.token.verified", outcome: "success" });
    await logger.record({ action: "authz.denied", outcome: "denied" });

    expect(calls).toEqual([
      { level: "info", message: "security.audit auth.token.verified" },
      { level: "warn", message: "security.audit authz.denied" },
    ]);
  });

  test("principal summaries exclude claims, roles, scopes, and token material", () => {
    const principal = fakePrincipal({
      roles: ["admin"],
      scopes: ["reports:read"],
      tenant: "tenant_1",
      claims: { api_key: "raw-secret", token: "raw-token" },
    });

    const summary = auditPrincipal(principal);

    expect(summary).toEqual({
      subject: "user_1",
      issuer: "https://issuer.test",
      tenant: "tenant_1",
    });
    expect("claims" in summary).toBe(false);
    expect("roles" in summary).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("raw-secret");
    expect(JSON.stringify(summary)).not.toContain("raw-token");
  });

  test("a sink failure does not corrupt the tamper-evident chain", async () => {
    let failNext = false;
    const events: AuditEvent[] = [];
    const logger = createAuditLogger({
      tamperEvident: true,
      sink: {
        record(event) {
          if (failNext) throw new Error("disk full");
          events.push(event);
        },
      },
    });

    await logger.record({ action: "a", outcome: "success" });
    failNext = true;
    await expect(
      logger.record({ action: "b", outcome: "success" }),
    ).rejects.toBeInstanceOf(AuditError);
    failNext = false;
    await logger.record({ action: "c", outcome: "success" });

    // The dropped event ("b") must not advance the chain: "c" links back to "a".
    expect(events).toHaveLength(2);
    expect(events[1]?.previousHash).toBe(events[0]?.hash);
    expect(await verifyAuditChain(events)).toBe(true);
  });

  test("sink failures surface as AuditError", async () => {
    const logger = createAuditLogger({
      sink: {
        record() {
          throw new Error("disk full");
        },
      },
    });

    await expect(
      logger.record({ action: "auth.token.failed", outcome: "failure" }),
    ).rejects.toBeInstanceOf(AuditError);
  });
});

import { describe, expect, test } from "bun:test";
import { staticProvider } from "../../../src/config/providers/static";

describe("staticProvider", () => {
  test("get() returns the exact snapshot it was constructed with", () => {
    const snapshot = { "features.newCheckout": "true" };
    const provider = staticProvider(snapshot);
    expect(provider.get()).toBe(snapshot);
  });

  test("subscribe() never fires its handler", () => {
    const provider = staticProvider({ a: "1" });
    let calls = 0;
    const unsub = provider.subscribe(() => {
      calls += 1;
    });
    // No way to trigger a snapshot — the provider is by definition
    // single-shot. Just confirm subscribe returned a callable and the
    // handler never fired synchronously.
    expect(typeof unsub).toBe("function");
    expect(calls).toBe(0);
  });

  test("subscribe() returned function is callable and idempotent", () => {
    const provider = staticProvider({});
    const unsub = provider.subscribe(() => {});
    expect(() => unsub()).not.toThrow();
    expect(() => unsub()).not.toThrow();
  });

  test("name defaults to 'static' and is overridable", () => {
    expect(staticProvider({}).name).toBe("static");
    expect(staticProvider({}, { name: "fixture-flags" }).name).toBe(
      "fixture-flags",
    );
  });
});

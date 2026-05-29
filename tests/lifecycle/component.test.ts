import { describe, expect, test } from "bun:test";
import { ComponentRegistrationError, asComponent } from "../../src/lifecycle";

describe("asComponent", () => {
  test("attaches only the hooks provided", () => {
    const c = asComponent("db", { stop: () => {} });
    expect(c.name).toBe("db");
    expect(typeof c.stop).toBe("function");
    expect(c.start).toBeUndefined();
    expect(c.healthcheck).toBeUndefined();
  });

  test("maps differently-named methods onto the seam", async () => {
    let shutdownCalled = false;
    const db = { shutdown: () => { shutdownCalled = true; } };
    const c = asComponent("db", { stop: () => db.shutdown() });
    await c.stop?.({ signal: new AbortController().signal, logger: console });
    expect(shutdownCalled).toBe(true);
  });

  test("throws ComponentRegistrationError on a blank name", () => {
    expect(() => asComponent("")).toThrow(ComponentRegistrationError);
    expect(() => asComponent("   ")).toThrow(ComponentRegistrationError);
  });

  test("an empty hook bag is allowed (a no-op component)", () => {
    const c = asComponent("noop");
    expect(c.name).toBe("noop");
    expect(c.start).toBeUndefined();
    expect(c.stop).toBeUndefined();
  });
});

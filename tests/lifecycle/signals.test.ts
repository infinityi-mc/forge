import { describe, expect, test } from "bun:test";
import { installSignalHandlers } from "../../src/lifecycle/signals";

interface FakeSource {
  on(s: NodeJS.Signals, l: (s: NodeJS.Signals) => void): void;
  off(s: NodeJS.Signals, l: (s: NodeJS.Signals) => void): void;
  emit(s: NodeJS.Signals): void;
  count(s: NodeJS.Signals): number;
}

function fakeSource(): FakeSource {
  const map = new Map<NodeJS.Signals, Set<(s: NodeJS.Signals) => void>>();
  return {
    on(s, l) {
      (map.get(s) ?? map.set(s, new Set()).get(s)!).add(l);
    },
    off(s, l) {
      map.get(s)?.delete(l);
    },
    emit(s) {
      for (const l of [...(map.get(s) ?? [])]) l(s);
    },
    count(s) {
      return map.get(s)?.size ?? 0;
    },
  };
}

describe("installSignalHandlers", () => {
  test("invokes onSignal once for the first matching signal", () => {
    const source = fakeSource();
    const received: NodeJS.Signals[] = [];
    const dispose = installSignalHandlers({
      signals: ["SIGTERM"],
      onSignal: (s) => {
        received.push(s);
      },
      source,
      exit: () => {},
    });
    source.emit("SIGTERM");
    dispose();
    expect(received).toEqual(["SIGTERM"]);
  });

  test("a second identical signal forces exit(1)", () => {
    const source = fakeSource();
    const exitCodes: number[] = [];
    let calls = 0;
    installSignalHandlers({
      signals: ["SIGTERM"],
      onSignal: () => {
        calls++;
      },
      source,
      exit: (c) => exitCodes.push(c),
    });
    source.emit("SIGTERM");
    source.emit("SIGTERM");
    expect(calls).toBe(1);
    expect(exitCodes).toEqual([1]);
  });

  test("forceExitOnSecond=false ignores the second signal without exiting", () => {
    const source = fakeSource();
    const exitCodes: number[] = [];
    let calls = 0;
    installSignalHandlers({
      signals: ["SIGTERM"],
      forceExitOnSecond: false,
      onSignal: () => {
        calls++;
      },
      source,
      exit: (c) => exitCodes.push(c),
    });
    source.emit("SIGTERM");
    source.emit("SIGTERM");
    expect(calls).toBe(1);
    expect(exitCodes).toEqual([]);
  });

  test("the disposer removes every listener and is safe to call twice", () => {
    const source = fakeSource();
    const dispose = installSignalHandlers({
      signals: ["SIGTERM", "SIGINT"],
      onSignal: () => {},
      source,
      exit: () => {},
    });
    expect(source.count("SIGTERM")).toBe(1);
    expect(source.count("SIGINT")).toBe(1);
    dispose();
    dispose();
    expect(source.count("SIGTERM")).toBe(0);
    expect(source.count("SIGINT")).toBe(0);
  });

  test("duplicate configured signals install only one listener", () => {
    const source = fakeSource();
    const dispose = installSignalHandlers({
      signals: ["SIGTERM", "SIGTERM"],
      onSignal: () => {},
      source,
      exit: () => {},
    });
    expect(source.count("SIGTERM")).toBe(1);
    dispose();
    expect(source.count("SIGTERM")).toBe(0);
  });

  test("defaults to SIGTERM and SIGINT", () => {
    const source = fakeSource();
    const dispose = installSignalHandlers({
      onSignal: () => {},
      source,
      exit: () => {},
    });
    expect(source.count("SIGTERM")).toBe(1);
    expect(source.count("SIGINT")).toBe(1);
    dispose();
  });
});

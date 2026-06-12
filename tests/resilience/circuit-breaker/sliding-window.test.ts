import { describe, expect, test } from "bun:test";
import {
  CountWindow,
  TimeWindow,
} from "../../../src/resilience/circuit-breaker/sliding-window";

describe("CountWindow", () => {
  test("tracks failures up to size", () => {
    const w = new CountWindow(3);
    w.record("failure", 0);
    w.record("success", 0);
    w.record("failure", 0);
    expect(w.failures(0)).toBe(2);
    expect(w.samples(0)).toBe(3);
  });

  test("tracks slow calls separately from failures", () => {
    const w = new CountWindow(3);
    w.record("failure", 0);
    w.record("slow", 0);
    w.record("success", 0);

    expect(w.failures(0)).toBe(1);
    expect(w.slow(0)).toBe(1);
    expect(w.samples(0)).toBe(3);
  });

  test("wraps around at size", () => {
    const w = new CountWindow(3);
    w.record("failure", 0);
    w.record("failure", 0);
    w.record("failure", 0);
    expect(w.failures(0)).toBe(3);
    w.record("success", 0);
    expect(w.failures(0)).toBe(2);
    expect(w.samples(0)).toBe(3);
    w.record("slow", 0);
    expect(w.failures(0)).toBe(1);
    expect(w.slow(0)).toBe(1);
    expect(w.samples(0)).toBe(3);
  });

  test("clear empties the window", () => {
    const w = new CountWindow(3);
    w.record("failure", 0);
    w.clear();
    expect(w.failures(0)).toBe(0);
    expect(w.slow(0)).toBe(0);
    expect(w.samples(0)).toBe(0);
  });

  test("rejects invalid sizes", () => {
    expect(() => new CountWindow(0)).toThrow(RangeError);
    expect(() => new CountWindow(1.5)).toThrow(RangeError);
  });
});

describe("TimeWindow", () => {
  test("evicts entries older than durationMs", () => {
    const w = new TimeWindow(100);
    w.record("failure", 10);
    w.record("failure", 60);
    expect(w.failures(60)).toBe(2);
    // At t=120 (cutoff=20), the t=10 entry has aged out; t=60 remains.
    expect(w.failures(120)).toBe(1);
    // At t=200 (cutoff=100), both entries have aged out.
    expect(w.failures(200)).toBe(0);
  });

  test("samples reflects current window contents", () => {
    const w = new TimeWindow(100);
    w.record("failure", 10);
    w.record("slow", 30);
    w.record("failure", 60);
    expect(w.samples(60)).toBe(3);
    expect(w.failures(60)).toBe(2);
    expect(w.slow(60)).toBe(1);
    // At t=120 (cutoff=20), the t=10 entry evicted.
    expect(w.samples(120)).toBe(2);
    expect(w.failures(120)).toBe(1);
    expect(w.slow(120)).toBe(1);
    // At t=140 (cutoff=40), the slow t=30 entry evicted.
    expect(w.slow(140)).toBe(0);
    expect(w.samples(140)).toBe(1);
  });

  test("rejects invalid durations", () => {
    expect(() => new TimeWindow(0)).toThrow(RangeError);
    expect(() => new TimeWindow(-1)).toThrow(RangeError);
  });
});

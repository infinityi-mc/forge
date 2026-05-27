import { describe, expect, test } from "bun:test";
import {
  constantBackoff,
  exponentialBackoff,
  linearBackoff,
} from "../../../src/resilience";

describe("backoff strategies", () => {
  test("constantBackoff returns the configured delay regardless of attempt", () => {
    const b = constantBackoff(250);
    expect(b.delay(1)).toBe(250);
    expect(b.delay(2)).toBe(250);
    expect(b.delay(99)).toBe(250);
  });

  test("constantBackoff clamps negative delays to 0", () => {
    expect(constantBackoff(-100).delay(1)).toBe(0);
  });

  test("linearBackoff (no jitter) grows linearly and respects max", () => {
    const b = linearBackoff({ initial: 100, max: 350 });
    expect(b.delay(1)).toBe(100);
    expect(b.delay(2)).toBe(200);
    expect(b.delay(3)).toBe(300);
    expect(b.delay(4)).toBe(350); // capped
    expect(b.delay(99)).toBe(350); // still capped
  });

  test("exponentialBackoff (no jitter) doubles up to max", () => {
    const b = exponentialBackoff({ initial: 100, max: 2_000, jitter: false });
    expect(b.delay(1)).toBe(100);
    expect(b.delay(2)).toBe(200);
    expect(b.delay(3)).toBe(400);
    expect(b.delay(4)).toBe(800);
    expect(b.delay(5)).toBe(1_600);
    expect(b.delay(6)).toBe(2_000); // capped
    expect(b.delay(20)).toBe(2_000); // still capped
  });

  test("exponentialBackoff respects custom factor", () => {
    const b = exponentialBackoff({ initial: 50, factor: 3, jitter: false });
    expect(b.delay(1)).toBe(50);
    expect(b.delay(2)).toBe(150);
    expect(b.delay(3)).toBe(450);
  });

  test("exponentialBackoff with jitter stays within [0, raw] for every attempt", () => {
    const b = exponentialBackoff({ initial: 100, max: 5_000 });
    for (let attempt = 1; attempt <= 10; attempt++) {
      const raw = Math.min(5_000, 100 * Math.pow(2, attempt - 1));
      for (let i = 0; i < 50; i++) {
        const d = b.delay(attempt);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(raw);
      }
    }
  });

  test("exponentialBackoff with jitter ON returns variable values", () => {
    const b = exponentialBackoff({ initial: 1_000, jitter: true });
    const sample = new Set<number>();
    for (let i = 0; i < 25; i++) sample.add(b.delay(3));
    // With jitter, at least two distinct values across 25 samples is
    // overwhelmingly likely; collisions only happen by chance.
    expect(sample.size).toBeGreaterThan(1);
  });
});

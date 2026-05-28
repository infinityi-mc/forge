import { describe, expect, test } from "bun:test";
import { Secret } from "../../../src/config/secret";
import { diff } from "../../../src/config/dynamic/diff";

describe("diff", () => {
  test("returns [] for structurally identical trees", () => {
    expect(diff({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toEqual([]);
  });

  test("returns the leaf path for a single primitive change", () => {
    expect(diff({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual(["b"]);
  });

  test("nests dotted paths for deeper changes", () => {
    expect(
      diff(
        { app: { port: 3000, env: "dev" } },
        { app: { port: 8080, env: "dev" } },
      ),
    ).toEqual(["app.port"]);
  });

  test("emits multiple changed paths sorted alphabetically", () => {
    const out = diff(
      { z: 1, a: { b: 1 }, m: 1 },
      { z: 2, a: { b: 2 }, m: 1 },
    );
    expect(out).toEqual(["a.b", "z"]);
  });

  test("reports a path that exists only on one side", () => {
    expect(diff({ a: 1 }, { a: 1, b: 2 })).toEqual(["b"]);
    expect(diff({ a: 1, b: 2 }, { a: 1 })).toEqual(["b"]);
  });

  test("compares URLs by string serialisation, not reference", () => {
    const a = new URL("https://example.com");
    const b = new URL("https://example.com");
    expect(diff({ u: a }, { u: b })).toEqual([]);

    const c = new URL("https://example.com/x");
    expect(diff({ u: a }, { u: c })).toEqual(["u"]);
  });

  test("compares Secret by unwrapped value, not reference", () => {
    expect(
      diff({ s: new Secret("alpha") }, { s: new Secret("alpha") }),
    ).toEqual([]);
    expect(
      diff({ s: new Secret("alpha") }, { s: new Secret("beta") }),
    ).toEqual(["s"]);
  });

  test("Secret<URL> equality recurses through the URL branch (no false-positive diff)", () => {
    // Two separate URL parses of the same string are not
    // reference-equal — without recursing back into `equal()`, the
    // unwrapped values would Object.is-false, producing a phantom
    // diff on every poll for any `t.url.secret()` leaf.
    const a = new Secret(new URL("https://example.com/path"));
    const b = new Secret(new URL("https://example.com/path"));
    expect(diff({ s: a }, { s: b })).toEqual([]);

    const c = new Secret(new URL("https://example.com/other"));
    expect(diff({ s: a }, { s: c })).toEqual(["s"]);
  });

  test("arrays of primitives compare by element-wise content (no false-positive diff)", () => {
    expect(diff({ a: [1, 2, 3] }, { a: [1, 2, 3] })).toEqual([]);
    expect(diff({ a: [1, 2, 3] }, { a: [1, 2, 4] })).toEqual(["a"]);
    // Differing length is a real change.
    expect(diff({ a: [1, 2, 3] }, { a: [1, 2, 3, 4] })).toEqual(["a"]);
    // Differing element order is a real change.
    expect(diff({ a: [1, 2, 3] }, { a: [3, 2, 1] })).toEqual(["a"]);
    // Empty arrays are equal.
    expect(diff({ a: [] as number[] }, { a: [] as number[] })).toEqual([]);
  });

  test("arrays of nested objects compare element-wise via the shared equal walker", () => {
    expect(
      diff(
        { rules: [{ id: 1, weight: 0.5 }, { id: 2, weight: 0.25 }] },
        { rules: [{ id: 1, weight: 0.5 }, { id: 2, weight: 0.25 }] },
      ),
    ).toEqual([]);
    expect(
      diff(
        { rules: [{ id: 1, weight: 0.5 }] },
        { rules: [{ id: 1, weight: 0.6 }] },
      ),
    ).toEqual(["rules"]);
  });

  test("array diffs surface a single path entry (no per-index walking)", () => {
    // `t.json<T[]>()` returns the array as one leaf — `diff` reflects
    // that: an array swap is one path entry, never N indexed paths.
    expect(diff({ a: [1, 2, 3] }, { a: [9, 9, 9] })).toEqual(["a"]);
  });

  test("handles NaN consistently via Object.is", () => {
    // `NaN === NaN` is false, but `Object.is(NaN, NaN)` is true. We want
    // the latter so a snapshot of `{ x: NaN }` doesn't false-positive
    // diff against itself.
    expect(diff({ x: Number.NaN }, { x: Number.NaN })).toEqual([]);
  });
});

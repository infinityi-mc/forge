import { describe, expect, test } from "bun:test";
import {
  dotenvSource,
  parseDotenv,
} from "../../../src/config/sources/dotenv";

describe("parseDotenv", () => {
  test("parses KEY=value with whitespace tolerance", () => {
    expect(parseDotenv("FOO=bar")).toEqual({ FOO: "bar" });
    expect(parseDotenv("  FOO  =  bar  ")).toEqual({ FOO: "bar" });
  });

  test("preserves whitespace inside double-quoted values", () => {
    expect(parseDotenv('FOO="  bar  "')).toEqual({ FOO: "  bar  " });
  });

  test("processes \\n / \\r / \\t / \\\" escapes inside double quotes only", () => {
    expect(parseDotenv('A="line1\\nline2"')).toEqual({ A: "line1\nline2" });
    expect(parseDotenv("A='line1\\nline2'")).toEqual({ A: "line1\\nline2" });
  });

  test("strips trailing comments on unquoted values", () => {
    expect(parseDotenv("FOO=bar # comment")).toEqual({ FOO: "bar" });
  });

  test("skips comment-only lines and blank lines", () => {
    expect(parseDotenv("# comment\n\nFOO=bar\n")).toEqual({ FOO: "bar" });
  });

  test("strips the `export` shell prefix", () => {
    expect(parseDotenv("export FOO=bar")).toEqual({ FOO: "bar" });
  });

  test("returns empty for malformed lines without an `=`", () => {
    expect(parseDotenv("not an env line")).toEqual({});
  });

  test("multiple keys in arrival order", () => {
    const out = parseDotenv("A=1\nB=2\nC=3");
    expect(out).toEqual({ A: "1", B: "2", C: "3" });
  });
});

describe("dotenvSource", () => {
  test("returns values by env-var name from supplied content", () => {
    const source = dotenvSource({ content: "FOO=bar\nBAZ=42" });
    expect(source.get({ path: "foo", envVar: "FOO" })).toBe("bar");
    expect(source.get({ path: "baz", envVar: "BAZ" })).toBe("42");
    expect(source.get({ path: "missing", envVar: "MISSING" })).toBeUndefined();
  });

  test("disabled=true short-circuits even when content is supplied", () => {
    const source = dotenvSource({
      disabled: true,
      content: "FOO=bar",
    });
    expect(source.get({ path: "foo", envVar: "FOO" })).toBeUndefined();
  });

  test("name is `dotenv` for boot summary", () => {
    expect(dotenvSource({ content: "" }).name).toBe("dotenv");
  });

  test("missing file is silently treated as empty (non-strict)", () => {
    const source = dotenvSource({
      path: "/non/existent/path/.env.never",
    });
    expect(source.get({ path: "anything", envVar: "ANYTHING" })).toBeUndefined();
  });
});

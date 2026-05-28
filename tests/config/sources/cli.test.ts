import { describe, expect, test } from "bun:test";
import { cliSource, parseFlags } from "../../../src/config/sources/cli";

describe("parseFlags", () => {
  test("parses --key=value", () => {
    expect(parseFlags(["--app.port=8080"])).toEqual({ "app.port": "8080" });
  });

  test("parses --key value", () => {
    expect(parseFlags(["--app.port", "8080"])).toEqual({ "app.port": "8080" });
  });

  test("treats a flag with no value as boolean true", () => {
    expect(parseFlags(["--debug"])).toEqual({ debug: "true" });
  });

  test("a flag immediately followed by another flag is boolean", () => {
    expect(parseFlags(["--debug", "--port", "8080"])).toEqual({
      debug: "true",
      port: "8080",
    });
  });

  test("ignores positional / unknown tokens", () => {
    expect(parseFlags(["script", "name", "--port", "3000"])).toEqual({
      port: "3000",
    });
  });
});

describe("cliSource", () => {
  test("matches by dotted path", () => {
    const source = cliSource({ argv: ["--app.port=8080"] });
    expect(source.get({ path: "app.port", envVar: "APP_PORT" })).toBe("8080");
  });

  test("matches by env-var name", () => {
    const source = cliSource({ argv: ["--APP_PORT", "8080"] });
    expect(source.get({ path: "app.port", envVar: "APP_PORT" })).toBe("8080");
  });

  test("dotted path takes precedence when both are supplied", () => {
    const source = cliSource({
      argv: ["--app.port=8080", "--APP_PORT=9999"],
    });
    expect(source.get({ path: "app.port", envVar: "APP_PORT" })).toBe("8080");
  });

  test("returns undefined when neither flag is present", () => {
    const source = cliSource({ argv: [] });
    expect(source.get({ path: "missing", envVar: "MISSING" })).toBeUndefined();
  });
});

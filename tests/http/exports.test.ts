import { describe, expect, test } from "bun:test";
import * as root from "../../src";
import * as http from "../../src/http";
import * as client from "../../src/http/client";
import * as problem from "../../src/http/problem";
import * as testing from "../../src/http/testing";

describe("forge/http exports", () => {
  test("http surface exposes the client, problem, and error taxonomy", () => {
    expect(http.createHttpClient).toBeFunction();
    expect(http.problem).toBeObject();
    expect(http.ProblemError).toBeFunction();
    expect(http.HttpError).toBeFunction();
    expect(http.RequestError).toBeFunction();
    expect(http.ResponseError).toBeFunction();
    expect(http.TimeoutError).toBeFunction();
    expect(http.jsonCodec).toBeObject();
  });

  test("subpath entrypoints are populated", () => {
    expect(client.createHttpClient).toBeFunction();
    expect(problem.problem).toBeObject();
    expect(problem.ProblemError).toBeFunction();
    expect(testing.createMockServer).toBeFunction();
    expect(testing.createTestHttp).toBeFunction();
    expect(testing.assertConformance).toBeFunction();
  });

  test("http symbols stay scoped to forge/http rather than the package root", () => {
    expect("createHttpClient" in root).toBe(false);
    expect("problem" in root).toBe(false);
  });
});

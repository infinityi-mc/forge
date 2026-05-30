import { describe, expect, test } from "bun:test";
import * as root from "../../src";
import * as http from "../../src/http";
import * as client from "../../src/http/client";
import * as server from "../../src/http/server";
import * as middleware from "../../src/http/middleware";
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

  test("http surface exposes the server + middleware (PR B)", () => {
    expect(http.createRouter).toBeFunction();
    expect(http.serve).toBeFunction();
    expect(http.compose).toBeFunction();
    expect(http.requestId).toBeFunction();
    expect(http.accessLog).toBeFunction();
    expect(http.cors).toBeFunction();
    expect(http.bodyLimit).toBeFunction();
    expect(http.rateLimit).toBeFunction();
    expect(http.auth).toBeFunction();
    expect(http.problemDetails).toBeFunction();
    expect(http.telemetryMiddleware).toBeFunction();
  });

  test("subpath entrypoints are populated", () => {
    expect(client.createHttpClient).toBeFunction();
    expect(server.createRouter).toBeFunction();
    expect(server.serve).toBeFunction();
    expect(middleware.problemDetails).toBeFunction();
    expect(middleware.requestId).toBeFunction();
    expect(problem.problem).toBeObject();
    expect(problem.ProblemError).toBeFunction();
    expect(testing.createMockServer).toBeFunction();
    expect(testing.createTestHttp).toBeFunction();
    expect(testing.testClient).toBeFunction();
    expect(testing.assertConformance).toBeFunction();
    expect(testing.assertServerConformance).toBeFunction();
  });

  test("http symbols stay scoped to forge/http rather than the package root", () => {
    expect("createHttpClient" in root).toBe(false);
    expect("problem" in root).toBe(false);
  });
});

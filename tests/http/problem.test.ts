import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PROBLEM_TYPE,
  PROBLEM_CONTENT_TYPE,
  ProblemError,
  normalizeProblem,
  problem,
  renderProblem,
} from "../../src/http/problem";
import { HttpError } from "../../src/http/errors";

describe("problem.* constructors", () => {
  const cases: ReadonlyArray<[keyof typeof problem, number]> = [
    ["badRequest", 400],
    ["unauthorized", 401],
    ["forbidden", 403],
    ["notFound", 404],
    ["conflict", 409],
    ["unprocessable", 422],
    ["tooManyRequests", 429],
    ["internal", 500],
  ];

  for (const [name, status] of cases) {
    test(`problem.${name}() → ${status}`, () => {
      const err = problem[name]("oops", { trace: "abc" });
      expect(err).toBeInstanceOf(ProblemError);
      expect(err).toBeInstanceOf(HttpError);
      expect(err.status).toBe(status);
      expect(err.problem.detail).toBe("oops");
      expect(err.problem.trace).toBe("abc");
    });
  }
});

describe("ProblemError", () => {
  test("normalizes type/title and exposes status", () => {
    const err = new ProblemError({ status: 404 });
    expect(err.problem.type).toBe(DEFAULT_PROBLEM_TYPE);
    expect(err.problem.title).toBe("Not Found");
    expect(err.status).toBe(404);
  });

  test("toResponse() renders application/problem+json with the status", async () => {
    const err = problem.unprocessable("bad", { errors: [{ field: "amount" }] });
    const res = err.toResponse();
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe(422);
    expect(body.title).toBe("Unprocessable Entity");
    expect(body.detail).toBe("bad");
    expect(body.errors).toEqual([{ field: "amount" }]);
  });
});

describe("normalizeProblem / renderProblem", () => {
  test("preserves extensions and fills defaults", () => {
    const normalized = normalizeProblem({ status: 409, code: "DUP" });
    expect(normalized.type).toBe(DEFAULT_PROBLEM_TYPE);
    expect(normalized.title).toBe("Conflict");
    expect(normalized.code).toBe("DUP");
  });

  test("renderProblem sets the RFC 7807 media type", async () => {
    const res = renderProblem({ status: 400, detail: "nope" });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.detail).toBe("nope");
  });
});

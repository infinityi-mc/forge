import { describe, expect, test } from "bun:test";
import { withContext } from "../../../src/telemetry/context";
import { tracedFetch } from "../../../src/telemetry/instrumentation/fetch";
import {
  createTracer,
  simpleSpanProcessor,
} from "../../../src/telemetry/trace";
import { recordingSpanExporter } from "../../../src/telemetry/trace/testing";

const resource = { serviceName: "fetch-test" };

function setup(): {
  tracer: ReturnType<typeof createTracer>;
  spans: ReturnType<typeof recordingSpanExporter>["spans"];
  exporter: ReturnType<typeof recordingSpanExporter>;
} {
  const exporter = recordingSpanExporter();
  const tracer = createTracer({
    resource,
    processor: simpleSpanProcessor({ exporter }),
  });
  return { tracer, exporter, spans: exporter.spans };
}

describe("tracedFetch", () => {
  test("creates a client span per request with HTTP attributes", async () => {
    const { tracer, spans } = setup();
    const captured: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      captured.push({
        url: typeof input === "string" ? input : (input as Request).url,
        init: init as RequestInit | undefined,
      });
      return new Response("ok", { status: 200 });
    };
    const fetch_ = tracedFetch({ tracer, fetch: fakeFetch });

    const res = await fetch_("https://api.example.com:8443/users?id=1", {
      method: "POST",
    });
    expect(res.status).toBe(200);

    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.kind).toBe("client");
    expect(span.name).toBe("HTTP POST");
    expect(span.attributes["http.request.method"]).toBe("POST");
    expect(span.attributes["http.response.status_code"]).toBe(200);
    expect(span.attributes["url.full"]).toBe(
      "https://api.example.com:8443/users?id=1",
    );
    expect(span.attributes["server.address"]).toBe("api.example.com");
    expect(span.attributes["server.port"]).toBe(8443);
    expect(span.attributes["url.scheme"]).toBe("https");
    expect(span.status.code).toBe("ok");
  });

  test("injects W3C traceparent when a context is active", async () => {
    const { tracer } = setup();
    const captured: { headers: Headers }[] = [];
    const fakeFetch = async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      captured.push({ headers: new Headers(init?.headers) });
      return new Response(null, { status: 204 });
    };
    const fetch_ = tracedFetch({ tracer, fetch: fakeFetch });

    await withContext(
      {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        traceFlags: 1,
        baggage: { tenant: "acme" },
      },
      async () => {
        await fetch_("https://api.example.com/x");
      },
    );

    const headers = captured[0]!.headers;
    const tp = headers.get("traceparent");
    expect(tp).toMatch(
      /^00-0af7651916cd43dd8448eb211c80319c-[0-9a-f]{16}-01$/,
    );
    expect(headers.get("baggage")).toBe("tenant=acme");
  });

  test("does not inject headers when no context is active", async () => {
    const { tracer } = setup();
    let captured: Headers | undefined;
    const fetch_ = tracedFetch({
      tracer,
      fetch: async (_input, init) => {
        captured = new Headers(init?.headers);
        return new Response(null, { status: 200 });
      },
    });
    await fetch_("https://api.example.com/x");
    expect(captured!.has("traceparent")).toBe(false);
  });

  test("disablePropagation skips header injection", async () => {
    const { tracer } = setup();
    let captured: Headers | undefined;
    const fetch_ = tracedFetch({
      tracer,
      disablePropagation: true,
      fetch: async (_input, init) => {
        captured = new Headers(init?.headers);
        return new Response(null, { status: 200 });
      },
    });
    await withContext(
      {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        traceFlags: 1,
        baggage: {},
      },
      async () => {
        await fetch_("https://api.example.com/x");
      },
    );
    expect(captured!.has("traceparent")).toBe(false);
  });

  test("marks 5xx responses as error status", async () => {
    const { tracer, spans } = setup();
    const fetch_ = tracedFetch({
      tracer,
      fetch: async () => new Response(null, { status: 503 }),
    });
    await fetch_("https://api.example.com/x");
    const span = spans[0]!;
    expect(span.status.code).toBe("error");
    expect(span.status.message).toBe("HTTP 503");
    expect(span.attributes["http.response.status_code"]).toBe(503);
  });

  test("does NOT mark 4xx responses as error status", async () => {
    const { tracer, spans } = setup();
    const fetch_ = tracedFetch({
      tracer,
      fetch: async () => new Response(null, { status: 404 }),
    });
    await fetch_("https://api.example.com/x");
    expect(spans[0]!.status.code).toBe("ok");
  });

  test("network failure records error.type and rethrows", async () => {
    const { tracer, spans } = setup();
    const fetch_ = tracedFetch({
      tracer,
      fetch: async () => {
        const err = new Error("ECONNREFUSED");
        err.name = "TypeError";
        throw err;
      },
    });
    await expect(fetch_("https://api.example.com/x")).rejects.toThrow(
      "ECONNREFUSED",
    );
    const span = spans[0]!;
    expect(span.status.code).toBe("error");
    expect(span.attributes["error.type"]).toBe("TypeError");
  });

  test("custom spanName and attributes are applied", async () => {
    const { tracer, spans } = setup();
    const fetch_ = tracedFetch({
      tracer,
      fetch: async () => new Response(null, { status: 200 }),
      spanName: () => "custom.name",
      attributes: () => ({ "custom.tag": "v" }),
    });
    await fetch_("https://api.example.com/x");
    const span = spans[0]!;
    expect(span.name).toBe("custom.name");
    expect(span.attributes["custom.tag"]).toBe("v");
  });

  test("uses Request.method when init.method is missing", async () => {
    const { tracer, spans } = setup();
    const fetch_ = tracedFetch({
      tracer,
      fetch: async () => new Response(null, { status: 200 }),
    });
    const req = new Request("https://api.example.com/x", { method: "DELETE" });
    await fetch_(req);
    expect(spans[0]!.name).toBe("HTTP DELETE");
  });
});

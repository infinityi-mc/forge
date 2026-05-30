/**
 * `forge/http/openapi` — derive an OpenAPI 3.1 document from the same route
 * definitions the router enforces at runtime (spec §6).
 *
 * The `Schema` used to *validate* a request body is the same one emitted as
 * the OpenAPI `requestBody` schema, so the document cannot drift from the
 * code. Generation is **document-only**: it never enforces response shapes at
 * runtime. `problemSchema()` documents RFC 7807 error responses as
 * first-class citizens.
 *
 * @module
 */

import { OpenApiError } from "../errors";
import { PROBLEM_CONTENT_TYPE } from "../problem";
import type { Handler, Middleware } from "../types";
import { routeMetadata } from "../server/router";
import type {
  JsonSchema,
  ResponseObject,
  RouteMeta,
  Router,
} from "../server/types";
import { objectShape, schemaToJson } from "./schema";

const DEFAULT_OPENAPI_VERSION = "3.1.0";
const JSON_CONTENT_TYPE = "application/json";

/** OpenAPI `info` object (the minimum required fields plus `description`). */
export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}

/** Options for {@link buildOpenApi}. */
export interface BuildOpenApiOptions {
  /** Required `info` block; `title` and `version` must be non-empty. */
  readonly info: OpenApiInfo;
  /** Optional `servers` array (e.g. `[{ url: "https://api.example.com" }]`). */
  readonly servers?: readonly { url: string; description?: string }[];
  /** Override the emitted `openapi` version string. Default `3.1.0`. */
  readonly openapi?: string;
}

/** A generated OpenAPI 3.1 document (a plain JSON object). */
export type OpenApiDocument = Record<string, unknown>;

/**
 * Build an OpenAPI 3.1 document from every {@link Router.route} registered on
 * `router` (mounted routes included, at their absolute paths).
 *
 * @throws {OpenApiError} when `info.title`/`info.version` are missing/empty.
 */
export function buildOpenApi(router: Router, options: BuildOpenApiOptions): OpenApiDocument {
  const { info } = options;
  if (!info || !info.title || !info.version) {
    throw new OpenApiError("buildOpenApi requires info.title and info.version");
  }

  const paths: Record<string, Record<string, unknown>> = {};
  for (const meta of routeMetadata(router)) {
    const templated = templatePath(meta.path);
    const item = (paths[templated] ??= {});
    const method = meta.method.toLowerCase();
    if (item[method]) {
      throw new OpenApiError(`duplicate OpenAPI operation ${meta.method} ${meta.path}`);
    }
    item[method] = operationOf(meta);
  }

  return {
    openapi: options.openapi ?? DEFAULT_OPENAPI_VERSION,
    info: { ...info },
    ...(options.servers ? { servers: options.servers.map((s) => ({ ...s })) } : {}),
    paths,
  };
}

/** Build a single OpenAPI operation object from a route's metadata. */
function operationOf(meta: RouteMeta): Record<string, unknown> {
  const op: Record<string, unknown> = {};
  if (meta.summary !== undefined) op["summary"] = meta.summary;
  if (meta.description !== undefined) op["description"] = meta.description;
  if (meta.tags !== undefined) op["tags"] = [...meta.tags];
  if (meta.operationId !== undefined) op["operationId"] = meta.operationId;

  const parameters = [...pathParameters(meta), ...queryParameters(meta)];
  if (parameters.length > 0) op["parameters"] = parameters;

  const body = meta.request?.body;
  if (body) {
    op["requestBody"] = {
      required: true,
      content: { [JSON_CONTENT_TYPE]: { schema: schemaToJson(body) } },
    };
  }

  op["responses"] = responsesOf(meta.responses);
  return op;
}

/** Path params come from the `:name` / `*name` segments, always required. */
function pathParameters(meta: RouteMeta): Record<string, unknown>[] {
  const shape = objectShape(meta.request?.params);
  const out: Record<string, unknown>[] = [];
  for (const segment of meta.path.split("/")) {
    if (segment.length === 0) continue;
    let name: string | undefined;
    if (segment.startsWith(":")) name = segment.slice(1);
    else if (segment === "*") name = "wildcard";
    else if (segment.startsWith("*")) name = segment.slice(1);
    if (name === undefined) continue;
    out.push({
      name,
      in: "path",
      required: true,
      schema: shape?.properties[name] ?? { type: "string" },
    });
  }
  return out;
}

/** Query params are expanded from the query schema's object properties. */
function queryParameters(meta: RouteMeta): Record<string, unknown>[] {
  const shape = objectShape(meta.request?.query);
  if (!shape) return [];
  const out: Record<string, unknown>[] = [];
  for (const [name, schema] of Object.entries(shape.properties)) {
    out.push({
      name,
      in: "query",
      required: shape.required.has(name),
      schema,
    });
  }
  return out;
}

/** Build the `responses` object; defaults to a bare `200` when none declared. */
function responsesOf(
  responses: Readonly<Record<number, ResponseObject>> | undefined,
): Record<string, unknown> {
  const entries = responses ? Object.entries(responses) : [];
  if (entries.length === 0) {
    return { "200": { description: "Successful response" } };
  }
  const out: Record<string, unknown> = {};
  for (const [status, response] of entries) {
    const description = response.description ?? defaultDescription(Number(status));
    const node: Record<string, unknown> = { description };
    if (response.body) {
      const contentType = response.contentType ?? JSON_CONTENT_TYPE;
      node["content"] = { [contentType]: { schema: schemaToJson(response.body) } };
    }
    out[status] = node;
  }
  return out;
}

function defaultDescription(status: number): string {
  if (status >= 500) return "Server error";
  if (status >= 400) return "Client error";
  if (status >= 300) return "Redirection";
  if (status >= 200) return "Success";
  return "Response";
}

/** `/orders/:id` → `/orders/{id}`; `*rest` → `{rest}`; `*` → `{wildcard}`. */
function templatePath(path: string): string {
  const segments = path
    .split("/")
    .filter((s) => s.length > 0)
    .map((segment) => {
      if (segment.startsWith(":")) return `{${segment.slice(1)}}`;
      if (segment === "*") return "{wildcard}";
      if (segment.startsWith("*")) return `{${segment.slice(1)}}`;
      return segment;
    });
  return `/${segments.join("/")}`;
}

/**
 * The RFC 7807 *Problem Details* schema, as a {@link ResponseObject} for use
 * in a route's `responses` (content type `application/problem+json`). Document
 * error contracts instead of leaving them implied.
 */
export function problemSchema(description = "Problem Details (RFC 7807)"): ResponseObject {
  return {
    description,
    contentType: PROBLEM_CONTENT_TYPE,
    // Document-only: responses are never validated, so `parse` is a passthrough.
    body: { parse: (input: unknown) => input, toJsonSchema: (): JsonSchema => PROBLEM_JSON_SCHEMA },
  };
}

const PROBLEM_JSON_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    type: { type: "string", format: "uri-reference", default: "about:blank" },
    title: { type: "string" },
    status: { type: "integer", format: "int32" },
    detail: { type: "string" },
    instance: { type: "string", format: "uri-reference" },
  },
  required: ["type", "title", "status"],
};

/** Options for {@link serveOpenApi}. */
export interface ServeOpenApiOptions {
  /** The document to serve (typically from {@link buildOpenApi}). */
  readonly doc: OpenApiDocument;
  /** Path the document is served at. Default `/openapi.json`. */
  readonly path?: string;
}

/**
 * Middleware that serves a pre-built OpenAPI document as JSON at `path`
 * (default `/openapi.json`) for `GET`/`HEAD`, delegating everything else to
 * `next`. Mount it with `router.use(serveOpenApi({ doc }))`.
 */
export function serveOpenApi(options: ServeOpenApiOptions): Middleware {
  const path = options.path ?? "/openapi.json";
  const payload = JSON.stringify(options.doc);
  return (next: Handler): Handler =>
    (req) => {
      if ((req.method === "GET" || req.method === "HEAD") && req.url.pathname === path) {
        return new Response(req.method === "HEAD" ? null : payload, {
          status: 200,
          headers: { "content-type": JSON_CONTENT_TYPE },
        });
      }
      return next(req);
    };
}

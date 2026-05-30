/**
 * Shared types for `forge/http`.
 *
 * PR A populates the client-facing primitives (`FetchLike`,
 * `ProblemDetails`, client request/response shapes). PR B adds the
 * server-facing contracts (`HttpRequest`, `Handler`, `Middleware`); the
 * `Router` surface lives in `server/types.ts`.
 *
 * @module
 */

/**
 * Minimal `fetch`-shape the client wraps and accepts for injection. We
 * use a stripped-down signature (instead of `typeof fetch`) so any
 * compatible implementation — including a `MockServer` or a
 * `tracedFetch` wrapper — drops in without colliding with Bun's
 * `fetch.preconnect` static method.
 */
export type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

/**
 * Web `BodyInit`, derived from `RequestInit` so the module works under
 * the repo's `lib: ["ESNext"]` (no DOM lib) Bun config.
 */
export type BodyInit = NonNullable<RequestInit["body"]>;

/** Web `HeadersInit`, derived the same way as {@link BodyInit}. */
export type HeadersInit = NonNullable<RequestInit["headers"]>;

/**
 * RFC 7807 / RFC 9457 *Problem Details*. `type` is a URI reference
 * (default `about:blank`); arbitrary extension members are allowed.
 */
export interface ProblemDetails {
  /** A URI reference identifying the problem type. Default `about:blank`. */
  readonly type: string;
  /** A short, human-readable summary of the problem type. */
  readonly title: string;
  /** The HTTP status code. */
  readonly status: number;
  /** A human-readable explanation specific to this occurrence. */
  readonly detail?: string;
  /** A URI reference identifying the specific occurrence. */
  readonly instance?: string;
  /** RFC 7807 permits arbitrary extension members. */
  readonly [extension: string]: unknown;
}

/**
 * A fully-described client request. The convenience verb methods
 * (`get`/`post`/…) build one of these for you.
 */
export interface ClientRequest extends ClientInit {
  /** HTTP method (case-insensitive; normalized to upper-case). */
  readonly method?: string;
  /** Target URL, resolved against `baseUrl` when relative. */
  readonly url: string;
  /** Request body. Encoded via the client's {@link Codec} unless a raw `BodyInit`. */
  readonly body?: unknown;
}

/** Per-call overrides accepted by the client verb methods. */
export interface ClientInit {
  readonly headers?: Record<string, string> | Headers;
  /** Caller-supplied cancellation; combined with the client's timeout. */
  readonly signal?: AbortSignal;
  /** Override `timeoutMs` for this single call. */
  readonly timeoutMs?: number;
  /** Query parameters appended to the URL. */
  readonly query?: Record<string, string | number | boolean | undefined> | URLSearchParams;
}

/** The decoded result of a client call. */
export interface HttpResponse<T> {
  readonly status: number;
  readonly headers: Headers;
  /** Decoded body (via the client's {@link Codec}). `undefined` for empty responses. */
  readonly body: T;
  /** Escape hatch to the underlying web {@link Response}. */
  readonly raw: Response;
}

// ---------------------------------------------------------------------------
// Server-facing contracts (PR B)
// ---------------------------------------------------------------------------

/**
 * The request a server {@link Handler} sees — a thin, ergonomic view over
 * the native web {@link Request}. We never replace the standard object;
 * `raw` is always available as the escape hatch.
 */
export interface HttpRequest {
  /** The native Bun/web {@link Request}. */
  readonly raw: Request;
  /** HTTP method, upper-cased. */
  readonly method: string;
  /** Parsed request {@link URL}. */
  readonly url: URL;
  /** Matched path parameters (e.g. `/users/:id` → `{ id }`). */
  readonly params: Readonly<Record<string, string>>;
  /** Query string parameters. */
  readonly query: URLSearchParams;
  /** Request headers. */
  readonly headers: Headers;
  /** Parse the body as JSON. */
  json<T = unknown>(): Promise<T>;
  /** Read the body as text. */
  text(): Promise<string>;
  /** Per-request scratch space for middleware (e.g. an auth principal). */
  readonly locals: Record<string, unknown>;
  /** Aborted when the client disconnects or the server shuts down. */
  readonly signal: AbortSignal;
}

/**
 * A request handler. Returns a native {@link Response} (sync or async).
 */
export type Handler = (req: HttpRequest) => Promise<Response> | Response;

/**
 * Middleware wraps a `next` handler and returns a new handler — exactly
 * the way a `forge/resilience` `Policy` wraps the next operation.
 * Composition is **outermost-first**: the first middleware in the array
 * sees the request first and the response last.
 */
export type Middleware = (next: Handler) => Handler;

/**
 * One or more middleware followed by a terminal {@link Handler}, as
 * accepted by the router verb methods (`router.get(path, ...handlers)`).
 * The last entry is the handler; any earlier entries are route-scoped
 * middleware.
 */
export type RouteHandlers = readonly [...Middleware[], Handler];

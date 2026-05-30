/**
 * {@link createRouter} — a segment-trie router with path params.
 *
 * Routes are stored in a trie keyed by path segment. Matching prefers a
 * **static** segment over a `:param` over a trailing `*` wildcard, with
 * backtracking so `/a/b` beats `/a/:x` without hiding either. Duplicate
 * `method`+`pattern` registrations and conflicting param names at the same
 * position throw a {@link RouteConflictError} **at registration**, not on
 * the first request (Principle 5: fail-fast at boot).
 *
 * The folded `handler()` runs router-wide `use` middleware outermost-first
 * around a dispatcher that resolves params, records the matched route on
 * `locals.route` (for telemetry), and runs the route's own handler chain.
 * Unmatched paths get a bare `404`; a path that matches another method
 * gets a `405` with an `Allow` header.
 *
 * @module
 */

import { RouteConflictError } from "../errors";
import type { Handler, Middleware, RouteHandlers } from "../types";
import { createHttpRequest } from "./request";
import { compose } from "./compose";
import type { Router, RouterOptions } from "./types";

interface TrieNode {
  /** Static segment → child. */
  readonly children: Map<string, TrieNode>;
  /** `:param` child (at most one per node). */
  param?: { readonly name: string; readonly node: TrieNode };
  /** Trailing `*` wildcard child (captures the rest of the path). */
  wildcard?: { readonly name: string; readonly node: TrieNode };
  /** method → composed handler for a route terminating here. */
  readonly handlers: Map<string, Handler>;
}

function newNode(): TrieNode {
  return { children: new Map(), handlers: new Map() };
}

/** Split a path into non-empty segments (`/` → `[]`). */
function segmentsOf(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

interface MatchResult {
  readonly node: TrieNode;
  readonly params: Record<string, string>;
  /** The registered pattern (`/users/:id`), for `http.route` labels. */
  readonly pattern: string;
}

/** Walk the trie, static → param → wildcard, with backtracking. */
function matchNode(
  node: TrieNode,
  segments: readonly string[],
  index: number,
  params: Record<string, string>,
  pattern: string,
): MatchResult | undefined {
  if (index === segments.length) {
    return node.handlers.size > 0
      ? { node, params, pattern: pattern === "" ? "/" : pattern }
      : undefined;
  }
  const segment = segments[index]!;

  const staticChild = node.children.get(segment);
  if (staticChild) {
    const hit = matchNode(staticChild, segments, index + 1, params, `${pattern}/${segment}`);
    if (hit) return hit;
  }
  if (node.param) {
    const hit = matchNode(
      node.param.node,
      segments,
      index + 1,
      { ...params, [node.param.name]: decode(segment) },
      `${pattern}/:${node.param.name}`,
    );
    if (hit) return hit;
  }
  if (node.wildcard) {
    const rest = segments.slice(index).map(decode).join("/");
    const wild = node.wildcard.node;
    if (wild.handlers.size > 0) {
      const name = node.wildcard.name;
      return {
        node: wild,
        params: { ...params, [name]: rest },
        pattern: `${pattern}/${name === "*" ? "*" : `*${name}`}`,
      };
    }
  }
  return undefined;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Create a composable {@link Router}. */
export function createRouter(options: RouterOptions = {}): Router {
  const root = newNode();
  const useMiddleware: Middleware[] = [];

  function register(method: string, path: string, handlers: RouteHandlers): void {
    const upper = method.toUpperCase();
    const terminal = handlers[handlers.length - 1] as Handler | undefined;
    if (typeof terminal !== "function") {
      throw new RouteConflictError(
        `route ${upper} ${path} must end with a handler function`,
      );
    }
    const routeMiddleware = handlers.slice(0, -1) as Middleware[];
    const composed = compose(routeMiddleware, terminal);

    let node = root;
    const segments = segmentsOf(path);
    for (const segment of segments) {
      if (segment === "*" || segment.startsWith("*")) {
        const name = segment.length > 1 ? segment.slice(1) : "*";
        if (!node.wildcard) node.wildcard = { name, node: newNode() };
        else if (node.wildcard.name !== name) {
          throw new RouteConflictError(
            `wildcard name conflict at "${segment}" in ${upper} ${path}`,
          );
        }
        node = node.wildcard.node;
      } else if (segment.startsWith(":")) {
        const name = segment.slice(1);
        if (!node.param) node.param = { name, node: newNode() };
        else if (node.param.name !== name) {
          throw new RouteConflictError(
            `param name conflict ":${node.param.name}" vs ":${name}" in ${upper} ${path}`,
          );
        }
        node = node.param.node;
      } else {
        let child = node.children.get(segment);
        if (!child) {
          child = newNode();
          node.children.set(segment, child);
        }
        node = child;
      }
    }

    if (node.handlers.has(upper)) {
      throw new RouteConflictError(`duplicate route ${upper} ${path}`);
    }
    node.handlers.set(upper, composed);
  }

  const notFound: Handler =
    options.notFound ?? (() => new Response("not found", { status: 404 }));

  const dispatch: Handler = (req) => {
    const segments = segmentsOf(req.url.pathname);
    const match = matchNode(root, segments, 0, {}, "");
    if (!match) return notFound(req);

    const handler = match.node.handlers.get(req.method);
    if (!handler) {
      const allow = [...match.node.handlers.keys()].sort().join(", ");
      return new Response("method not allowed", {
        status: 405,
        headers: { allow },
      });
    }
    Object.assign(req.params as Record<string, string>, match.params);
    req.locals.route = match.pattern;
    return handler(req);
  };

  const router: Router = {
    on(method, path, ...handlers) {
      register(method, path, handlers);
      return router;
    },
    get(path, ...handlers) {
      return router.on("GET", path, ...handlers);
    },
    post(path, ...handlers) {
      return router.on("POST", path, ...handlers);
    },
    put(path, ...handlers) {
      return router.on("PUT", path, ...handlers);
    },
    patch(path, ...handlers) {
      return router.on("PATCH", path, ...handlers);
    },
    delete(path, ...handlers) {
      return router.on("DELETE", path, ...handlers);
    },
    use(mw) {
      useMiddleware.push(mw);
      return router;
    },
    mount(prefix, sub) {
      for (const route of exportRoutes(sub)) {
        register(route.method, joinPath(prefix, route.path), [route.handler]);
      }
      return router;
    },
    handler() {
      return compose(useMiddleware, dispatch);
    },
  };

  // Internal: expose registered routes for `mount` to re-home. Stored as a
  // hidden property so a parent router can absorb a sub-router's routes
  // (with the sub-router's own `use` middleware already folded in).
  Object.defineProperty(router, ROUTES, {
    enumerable: false,
    value: (): ExportedRoute[] => collectRoutes(root, useMiddleware),
  });

  return router;
}

// --- mount support -------------------------------------------------------

const ROUTES = Symbol("forge.http.router.routes");

interface ExportedRoute {
  readonly method: string;
  readonly path: string;
  readonly handler: Handler;
}

function exportRoutes(sub: Router): ExportedRoute[] {
  const fn = (sub as unknown as Record<symbol, unknown>)[ROUTES];
  if (typeof fn !== "function") {
    throw new RouteConflictError("mount() expects a forge/http Router");
  }
  return (fn as () => ExportedRoute[])();
}

/** Walk the trie, rebuilding each route's pattern + handler (sub `use` folded). */
function collectRoutes(
  root: TrieNode,
  useMiddleware: readonly Middleware[],
): ExportedRoute[] {
  const out: ExportedRoute[] = [];
  const walk = (node: TrieNode, prefix: string): void => {
    for (const [method, handler] of node.handlers) {
      out.push({
        method,
        path: prefix === "" ? "/" : prefix,
        handler: compose(useMiddleware, handler),
      });
    }
    for (const [segment, child] of node.children) {
      walk(child, `${prefix}/${segment}`);
    }
    if (node.param) walk(node.param.node, `${prefix}/:${node.param.name}`);
    if (node.wildcard) {
      const name = node.wildcard.name;
      walk(node.wildcard.node, `${prefix}/${name === "*" ? "*" : `*${name}`}`);
    }
  };
  walk(root, "");
  return out;
}

function joinPath(prefix: string, path: string): string {
  const a = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const b = path === "/" ? "" : path.startsWith("/") ? path : `/${path}`;
  const joined = `${a}${b}`;
  return joined.startsWith("/") ? joined : `/${joined}`;
}

/**
 * `forge/lifecycle/adapters` — thin official adapters that wrap `forge/data`,
 * `forge/http`, and `forge/messaging` objects into {@link Component}s with
 * sensible `healthcheck`s, so the Quick Start `components: [db, http, ...]`
 * "just works".
 *
 * The adapters are typed against minimal structural `*Like` interfaces, so they
 * add **no** hard dependency on the other modules — the real objects already
 * conform.
 *
 * @module
 */

export { databaseComponent, poolComponent } from "./data";
export { httpServerComponent } from "./http";
export {
  consumerComponent,
  messageBusComponent,
  relayComponent,
  workerComponent,
} from "./messaging";

export type {
  AdapterOptions,
  DatabaseComponentOptions,
  DatabaseLike,
  HttpServerComponentOptions,
  HttpServerLike,
  MessageBusLike,
  PoolLike,
  StartStopLike,
} from "./types";

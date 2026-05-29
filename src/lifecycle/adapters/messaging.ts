/**
 * `forge/messaging` adapters — wrap a bus, consumer, relay, or worker into a
 * {@link Component}.
 *
 * Order them **after** the database in the components array so they stop
 * **before** it (strict reverse): in-flight handlers finish their writes while
 * the connection is still open.
 *
 * @module
 */

import { asComponent } from "../component";
import type { Component } from "../types";
import type { AdapterOptions, MessageBusLike, StartStopLike } from "./types";

/** Wrap a `start`/`stop` background runner. Shared by consumer/relay/worker. */
function startStopComponent(
  name: string,
  runner: StartStopLike,
  options: AdapterOptions,
): Component {
  return asComponent(name, {
    start: () => runner.start(),
    stop: () => runner.stop(),
    ...(options.healthcheck !== undefined
      ? { healthcheck: options.healthcheck }
      : {}),
  });
}

/**
 * Adapt a `forge/messaging` `MessageBus` into a {@link Component}. `stop()`
 * flushes in-flight publishes, then releases the transport.
 */
export function messageBusComponent(
  name: string,
  bus: MessageBusLike,
  options: AdapterOptions = {},
): Component {
  return asComponent(name, {
    stop: async () => {
      await bus.flush();
      await bus.shutdown();
    },
    ...(options.healthcheck !== undefined
      ? { healthcheck: options.healthcheck }
      : {}),
  });
}

/** Adapt a `forge/messaging` `MessageConsumer` (`start`/`stop`). */
export function consumerComponent(
  name: string,
  consumer: StartStopLike,
  options: AdapterOptions = {},
): Component {
  return startStopComponent(name, consumer, options);
}

/** Adapt a `forge/messaging` `OutboxRelay` (`start`/`stop`). */
export function relayComponent(
  name: string,
  relay: StartStopLike,
  options: AdapterOptions = {},
): Component {
  return startStopComponent(name, relay, options);
}

/** Adapt a `forge/messaging` jobs `Worker` (`start`/`stop`). */
export function workerComponent(
  name: string,
  worker: StartStopLike,
  options: AdapterOptions = {},
): Component {
  return startStopComponent(name, worker, options);
}

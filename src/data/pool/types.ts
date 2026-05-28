import type { DataTelemetryOptions } from "../types";

export type PoolResource = object & {
  shutdown?(): Promise<void> | void;
};

export interface PoolLease<Resource extends PoolResource> {
  readonly resource: Resource;
  release(): void;
}

export interface PoolOptions<Resource extends PoolResource> {
  readonly name?: string;
  readonly min?: number;
  readonly max: number;
  readonly acquireTimeoutMs?: number;
  readonly create: () => Promise<Resource> | Resource;
  readonly telemetry?: Pick<DataTelemetryOptions, "meter">;
}

export interface PoolStats {
  readonly active: number;
  readonly idle: number;
  readonly waiting: number;
  readonly total: number;
  readonly draining: boolean;
}

export interface Pool<Resource extends PoolResource> {
  readonly name: string;
  acquire(): Promise<PoolLease<Resource>>;
  stats(): PoolStats;
  drain(): Promise<void>;
  shutdown(): Promise<void>;
}

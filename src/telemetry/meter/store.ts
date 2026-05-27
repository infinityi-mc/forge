/**
 * Internal series store. Every instrument writes its points here,
 * keyed by `(instrument, attribute-tuple)`. On `collect()` the meter
 * snapshots the store and produces a {@link MetricBatch}.
 *
 * Aggregations:
 * - counter / up-down-counter — running sum per attribute set.
 * - gauge — last value per attribute set.
 * - histogram — count, sum, min, max, bucketCounts per attribute set.
 *
 * @module
 */

import type {
  AggregationTemporality,
  HistogramPoint,
  InstrumentDescriptor,
  MetricAttributes,
  MetricData,
  NumberPoint,
} from "./types";

/**
 * Stable key for a `(instrument, attributes)` series. Attributes are
 * sorted by key before joining so `{a:1,b:2}` and `{b:2,a:1}` collide.
 */
function seriesKey(attributes: MetricAttributes): string {
  const keys = Object.keys(attributes).sort();
  if (keys.length === 0) return "";
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(`${k}=${String(attributes[k])}`);
  }
  return parts.join("\x1f");
}

interface NumberSeries {
  attributes: MetricAttributes;
  value: number;
  startTime: Date;
  lastUpdated: Date;
}

interface HistogramSeries {
  attributes: MetricAttributes;
  count: number;
  sum: number;
  min: number;
  max: number;
  bucketCounts: number[];
  startTime: Date;
  lastUpdated: Date;
}

interface NumberInstrumentState {
  kind: "counter" | "up-down-counter" | "gauge";
  descriptor: InstrumentDescriptor;
  monotonic: boolean;
  series: Map<string, NumberSeries>;
}

interface HistogramInstrumentState {
  kind: "histogram";
  descriptor: InstrumentDescriptor;
  boundaries: readonly number[];
  series: Map<string, HistogramSeries>;
}

type InstrumentState = NumberInstrumentState | HistogramInstrumentState;

export class MetricStore {
  private readonly instruments = new Map<string, InstrumentState>();
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  registerNumberInstrument(
    descriptor: InstrumentDescriptor,
    kind: "counter" | "up-down-counter" | "gauge",
    monotonic: boolean,
  ): void {
    if (this.instruments.has(descriptor.name)) return;
    this.instruments.set(descriptor.name, {
      kind,
      descriptor,
      monotonic,
      series: new Map(),
    });
  }

  registerHistogramInstrument(
    descriptor: InstrumentDescriptor,
    boundaries: readonly number[],
  ): void {
    if (this.instruments.has(descriptor.name)) return;
    this.instruments.set(descriptor.name, {
      kind: "histogram",
      descriptor,
      boundaries,
      series: new Map(),
    });
  }

  addToNumber(
    name: string,
    value: number,
    attributes: MetricAttributes,
  ): void {
    const inst = this.instruments.get(name);
    if (!inst || inst.kind === "histogram") return;
    const key = seriesKey(attributes);
    const now = this.now();
    let series = inst.series.get(key);
    if (!series) {
      series = {
        attributes,
        value: 0,
        startTime: now,
        lastUpdated: now,
      };
      inst.series.set(key, series);
    }
    series.value += value;
    series.lastUpdated = now;
  }

  setNumber(name: string, value: number, attributes: MetricAttributes): void {
    const inst = this.instruments.get(name);
    if (!inst || inst.kind === "histogram") return;
    const key = seriesKey(attributes);
    const now = this.now();
    let series = inst.series.get(key);
    if (!series) {
      series = {
        attributes,
        value,
        startTime: now,
        lastUpdated: now,
      };
      inst.series.set(key, series);
      return;
    }
    series.value = value;
    series.lastUpdated = now;
  }

  recordHistogram(
    name: string,
    value: number,
    attributes: MetricAttributes,
  ): void {
    const inst = this.instruments.get(name);
    if (!inst || inst.kind !== "histogram") return;
    const key = seriesKey(attributes);
    const now = this.now();
    let series = inst.series.get(key);
    if (!series) {
      series = {
        attributes,
        count: 0,
        sum: 0,
        min: value,
        max: value,
        bucketCounts: new Array(inst.boundaries.length + 1).fill(0),
        startTime: now,
        lastUpdated: now,
      };
      inst.series.set(key, series);
    }
    series.count += 1;
    series.sum += value;
    if (value < series.min) series.min = value;
    if (value > series.max) series.max = value;
    series.lastUpdated = now;
    series.bucketCounts[bucketIndex(value, inst.boundaries)]! += 1;
  }

  /**
   * Snapshot the store into per-instrument metric data. When
   * `temporality === "delta"`, accumulating instruments (counters,
   * histograms) reset to a fresh zero after the snapshot so the next
   * collection reports only the delta window.
   */
  collect(temporality: AggregationTemporality): MetricData[] {
    const out: MetricData[] = [];
    const collectedAt = this.now();
    for (const inst of this.instruments.values()) {
      if (inst.kind === "histogram") {
        const points: HistogramPoint[] = [];
        for (const s of inst.series.values()) {
          points.push({
            attributes: s.attributes,
            count: s.count,
            sum: s.sum,
            min: s.count > 0 ? s.min : 0,
            max: s.count > 0 ? s.max : 0,
            boundaries: inst.boundaries,
            bucketCounts: [...s.bucketCounts],
            startTime: s.startTime,
            time: collectedAt,
          });
        }
        out.push({
          kind: "histogram",
          descriptor: inst.descriptor,
          temporality,
          points,
        });
        if (temporality === "delta") {
          for (const s of inst.series.values()) {
            s.count = 0;
            s.sum = 0;
            s.min = 0;
            s.max = 0;
            s.bucketCounts.fill(0);
            s.startTime = collectedAt;
          }
        }
        continue;
      }
      const points: NumberPoint[] = [];
      for (const s of inst.series.values()) {
        points.push({
          attributes: s.attributes,
          value: s.value,
          startTime: s.startTime,
          time: collectedAt,
        });
      }
      if (inst.kind === "gauge") {
        out.push({ kind: "gauge", descriptor: inst.descriptor, points });
      } else {
        out.push({
          kind: inst.kind,
          descriptor: inst.descriptor,
          temporality,
          monotonic: inst.monotonic,
          points,
        });
        if (temporality === "delta") {
          for (const s of inst.series.values()) {
            s.value = 0;
            s.startTime = collectedAt;
          }
        }
      }
    }
    return out;
  }
}

function bucketIndex(value: number, boundaries: readonly number[]): number {
  for (let i = 0; i < boundaries.length; i++) {
    if (value <= boundaries[i]!) return i;
  }
  return boundaries.length;
}

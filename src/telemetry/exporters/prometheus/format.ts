/**
 * Prometheus text exposition format (v0.0.4).
 *
 * Spec: https://prometheus.io/docs/instrumenting/exposition_formats/
 *
 * @module
 */

import type {
  HistogramPoint,
  MetricBatch,
  MetricData,
  NumberPoint,
} from "../../meter/types";

/**
 * Serialize a {@link MetricBatch} into Prometheus text exposition
 * format. Output ends with a trailing newline so it can be sent as-is
 * to a scrape endpoint.
 */
export function formatPrometheus(batch: MetricBatch): string {
  const lines: string[] = [];
  for (const metric of batch.metrics) {
    appendMetric(lines, metric);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function appendMetric(lines: string[], metric: MetricData): void {
  const name = sanitizeName(metric.descriptor.name);
  const help = metric.descriptor.description
    ? `# HELP ${name} ${escapeHelp(metric.descriptor.description)}`
    : `# HELP ${name} ${name}`;
  lines.push(help);

  switch (metric.kind) {
    case "counter":
      lines.push(`# TYPE ${name} counter`);
      for (const point of metric.points) {
        lines.push(`${name}${labels(point.attributes)} ${formatValue(point.value)}`);
      }
      break;
    case "up-down-counter":
      // Prometheus models these as gauges (the type is not monotonic).
      lines.push(`# TYPE ${name} gauge`);
      for (const point of metric.points) {
        lines.push(`${name}${labels(point.attributes)} ${formatValue(point.value)}`);
      }
      break;
    case "gauge":
      lines.push(`# TYPE ${name} gauge`);
      for (const point of metric.points) {
        lines.push(`${name}${labels(point.attributes)} ${formatValue(point.value)}`);
      }
      break;
    case "histogram":
      lines.push(`# TYPE ${name} histogram`);
      for (const point of metric.points) {
        appendHistogram(lines, name, point);
      }
      break;
  }
}

function appendHistogram(
  lines: string[],
  name: string,
  point: HistogramPoint,
): void {
  let cumulative = 0;
  for (let i = 0; i < point.boundaries.length; i++) {
    cumulative += point.bucketCounts[i]!;
    const le = point.boundaries[i]!;
    lines.push(
      `${name}_bucket${labels(point.attributes, { le: formatValue(le) })} ${cumulative}`,
    );
  }
  cumulative += point.bucketCounts[point.bucketCounts.length - 1]!;
  lines.push(
    `${name}_bucket${labels(point.attributes, { le: "+Inf" })} ${cumulative}`,
  );
  lines.push(
    `${name}_sum${labels(point.attributes)} ${formatValue(point.sum)}`,
  );
  lines.push(
    `${name}_count${labels(point.attributes)} ${point.count}`,
  );
}

function labels(
  attrs: Readonly<Record<string, string | number | boolean>>,
  extra?: Record<string, string>,
): string {
  const entries: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    entries.push(`${sanitizeLabel(k)}="${escapeLabelValue(String(v))}"`);
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      entries.push(`${sanitizeLabel(k)}="${escapeLabelValue(v)}"`);
    }
  }
  return entries.length === 0 ? "" : `{${entries.join(",")}}`;
}

/**
 * Prometheus metric names must match `[a-zA-Z_:][a-zA-Z0-9_:]*`.
 * Convert OTLP-style dots/dashes to underscores.
 */
export function sanitizeName(name: string): string {
  let out = name.replace(/[^a-zA-Z0-9_:]/g, "_");
  if (!/^[a-zA-Z_:]/.test(out)) out = `_${out}`;
  return out;
}

function sanitizeLabel(name: string): string {
  let out = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!/^[a-zA-Z_]/.test(out)) out = `_${out}`;
  return out;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) {
    if (value === Number.POSITIVE_INFINITY) return "+Inf";
    if (value === Number.NEGATIVE_INFINITY) return "-Inf";
    return "NaN";
  }
  return String(value);
}

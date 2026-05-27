/**
 * Probability sampler — keep a `rate` fraction of spans (0..1).
 *
 * Decision is deterministic per-trace: we map the last 8 hex chars of
 * the trace id to a uniform `[0, 1)` value so all spans in the same
 * trace get the same sampling decision. This matches OTel's
 * TraceIdRatioBasedSampler.
 *
 * @module
 */

import { TRACE_FLAGS } from "../../context/types";
import type { Sampler } from "../types";

export interface RatioSamplerOptions {
  /** Sampling probability in `[0, 1]`. */
  rate: number;
}

export function ratioSampler(options: RatioSamplerOptions): Sampler {
  const rate = clamp(options.rate, 0, 1);
  return {
    description: `RatioSampler(${rate})`,
    shouldSample(parentTraceId) {
      if (rate <= 0) return { decision: "drop" };
      if (rate >= 1) return { decision: "record_and_sampled" };
      if (!parentTraceId) return { decision: "drop" };
      const hex = parentTraceId.slice(-8);
      const value = parseInt(hex, 16);
      if (!Number.isFinite(value)) return { decision: "drop" };
      const uniform = value / 0x100000000;
      return uniform < rate
        ? { decision: "record_and_sampled" }
        : { decision: "drop" };
    },
  };
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// re-export so callers don't need a separate import for the SAMPLED bit
export { TRACE_FLAGS };

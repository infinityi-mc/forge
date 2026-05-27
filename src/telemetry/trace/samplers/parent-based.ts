/**
 * Parent-based sampler — defers to a delegate sampler based on the
 * parent span's sampled flag.
 *
 * - If there is no parent, the root sampler runs.
 * - If the parent was sampled (`traceFlags & SAMPLED`), the
 *   `remoteParentSampled` / `localParentSampled` sampler runs.
 * - Otherwise the `*NotSampled` sampler runs.
 *
 * This matches OTel's ParentBasedSampler, modulo we don't distinguish
 * remote vs. local — callers can pass the same sampler to both or
 * provide separate ones.
 *
 * @module
 */

import { TRACE_FLAGS } from "../../context/types";
import type { Sampler } from "../types";
import { alwaysOffSampler } from "./always-off";
import { alwaysOnSampler } from "./always-on";

export interface ParentBasedSamplerOptions {
  /** Sampler used when no parent context exists. */
  root: Sampler;
  /** Sampler used when the parent is sampled. Defaults to alwaysOn. */
  parentSampled?: Sampler;
  /** Sampler used when the parent is not sampled. Defaults to alwaysOff. */
  parentNotSampled?: Sampler;
}

export function parentBasedSampler(options: ParentBasedSamplerOptions): Sampler {
  const root = options.root;
  const onSampled = options.parentSampled ?? alwaysOnSampler();
  const offSampled = options.parentNotSampled ?? alwaysOffSampler();
  return {
    description: `ParentBased(root=${root.description}, sampled=${onSampled.description}, notSampled=${offSampled.description})`,
    shouldSample(parentTraceId, parentSpanId, parentTraceFlags, name, kind, attrs, links) {
      if (!parentSpanId) {
        return root.shouldSample(parentTraceId, parentSpanId, parentTraceFlags, name, kind, attrs, links);
      }
      const sampled = ((parentTraceFlags ?? 0) & TRACE_FLAGS.SAMPLED) !== 0;
      const delegate = sampled ? onSampled : offSampled;
      return delegate.shouldSample(parentTraceId, parentSpanId, parentTraceFlags, name, kind, attrs, links);
    },
  };
}

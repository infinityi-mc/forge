/**
 * Always-off sampler — no span is recorded or sampled.
 *
 * @module
 */

import type { Sampler } from "../types";

export function alwaysOffSampler(): Sampler {
  return {
    description: "AlwaysOffSampler",
    shouldSample() {
      return { decision: "drop" };
    },
  };
}

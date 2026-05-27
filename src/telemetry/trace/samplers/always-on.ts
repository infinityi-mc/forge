/**
 * Always-on sampler — every span is recorded and sampled.
 *
 * @module
 */

import type { Sampler } from "../types";

export function alwaysOnSampler(): Sampler {
  return {
    description: "AlwaysOnSampler",
    shouldSample() {
      return { decision: "record_and_sampled" };
    },
  };
}

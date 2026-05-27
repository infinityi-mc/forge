/**
 * Null exporter for `forge/telemetry/meter` — discards every batch.
 *
 * @module
 */

import type { MeterExporter } from "../../types";

export function nullMeterExporter(): MeterExporter {
  return {
    export() {},
    async flush() {},
    async shutdown() {},
  };
}

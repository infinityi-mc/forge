/**
 * Null exporter — discards every record. Useful for silenced loggers,
 * tests that don't care about output, and benchmarks measuring the
 * pipeline cost independent of I/O.
 *
 * @module
 */

import type { LogExporter } from "../../types";

export function nullExporter(): LogExporter {
  return {
    export() {},
    async flush() {},
    async shutdown() {},
  };
}

/**
 * Null span exporter — discards every span.
 *
 * @module
 */

import type { SpanExporter } from "../../types";

export function nullSpanExporter(): SpanExporter {
  return {
    export() {},
    async flush() {},
    async shutdown() {},
  };
}

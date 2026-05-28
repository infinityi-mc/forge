/**
 * Errors thrown or used internally by the hedge policy.
 *
 * @module
 */

import { ResilienceError } from "../errors";

/**
 * Used as the AbortSignal reason for hedged attempts that lost the
 * race. The losing attempt's `next(ctx)` typically catches this when
 * its cooperating I/O honors the abort, so user code can pattern-match
 * on it if needed. It is *not* propagated out of the policy — the
 * winner's value (or, if all attempts failed, the underlying error)
 * is.
 */
export class HedgeCancelledError extends ResilienceError {
  constructor(message = "hedge: cancelled because a sibling attempt won") {
    super(message);
    this.name = "HedgeCancelledError";
  }
}

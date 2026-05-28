/**
 * Diagnostic table formatter — turns a list of {@link ConfigDiagnostic}
 * into the box-drawn rendering the module spec illustrates.
 *
 * Pure string output: no I/O, no `process.exit`. The stderr writer +
 * exit logic live in {@link writeFailFast} so this function stays
 * trivially testable.
 *
 * The emoji characters (`❌`) are intentional — the spec example
 * shows them and the formatter is the user-facing surface for boot
 * failures, where high-signal visual contrast matters more than the
 * usual "no emojis in code" guideline.
 *
 * @module
 */

import type { ConfigDiagnostic } from "../errors";

export interface FormatDiagnosticsOptions {
  /** Maximum total width of the table. Defaults to `80`. */
  width?: number;
  /** Render ANSI color codes (red header / status). Defaults to `false`. */
  color?: boolean;
}

const COL_VAR = "Variable";
const COL_STATUS = "Status";
const COL_REASON = "Reason";

// `❌` is two visual columns under most monospace fonts; budget for it.
const STATUS_MISSING = "\u274c Missing";
const STATUS_INVALID = "\u274c Invalid";

/**
 * Render a sequence of diagnostics into the fail-fast table. The
 * output ends with a trailing newline and a final
 * "Process exited with code 1." sentinel matching the spec example.
 */
export function formatDiagnostics(
  issues: readonly ConfigDiagnostic[],
  options: FormatDiagnosticsOptions = {},
): string {
  const width = Math.max(60, options.width ?? 80);
  const color = options.color === true;

  // Distribute the budget: the status column is fixed-width (longest
  // canonical token + a small pad); the variable column flexes to the
  // longest variable name; the reason column gets the rest.
  const statusWidth = Math.max(
    visualWidth(COL_STATUS),
    visualWidth(STATUS_MISSING),
    visualWidth(STATUS_INVALID),
  );
  const varWidth = Math.max(
    visualWidth(COL_VAR),
    ...issues.map((i) => i.envVar.length),
  );
  // 3 column separators (`│ … │ … │ … │`) + 4 spaces of padding.
  const overhead = 3 + 2 * 3;
  const reasonWidth = Math.max(
    visualWidth(COL_REASON),
    width - varWidth - statusWidth - overhead,
  );

  const lines: string[] = [];
  const header = `${red(color, "\u274c Forge Configuration Error: Invalid environment variables.")}\n`;
  lines.push(header);

  const borderTop = boxLine("\u250c", "\u252c", "\u2510", varWidth, statusWidth, reasonWidth);
  const borderMid = boxLine("\u251c", "\u253c", "\u2524", varWidth, statusWidth, reasonWidth);
  const borderBot = boxLine("\u2514", "\u2534", "\u2518", varWidth, statusWidth, reasonWidth);

  lines.push(borderTop);
  lines.push(
    row(
      COL_VAR,
      COL_STATUS,
      COL_REASON,
      varWidth,
      statusWidth,
      reasonWidth,
      false,
      color,
    ),
  );
  lines.push(borderMid);

  issues.forEach((issue, idx) => {
    const status = issue.status === "missing" ? STATUS_MISSING : STATUS_INVALID;
    const reasonLines = wrap(issue.reason, reasonWidth);
    reasonLines.forEach((segment, segIdx) => {
      lines.push(
        row(
          segIdx === 0 ? issue.envVar : "",
          segIdx === 0 ? status : "",
          segment,
          varWidth,
          statusWidth,
          reasonWidth,
          segIdx === 0,
          color,
        ),
      );
    });
    if (idx < issues.length - 1) lines.push(borderMid);
  });

  lines.push(borderBot);
  lines.push("");
  lines.push("Process exited with code 1.");
  return lines.join("\n") + "\n";
}

function boxLine(
  left: string,
  mid: string,
  right: string,
  varWidth: number,
  statusWidth: number,
  reasonWidth: number,
): string {
  const hbar = (n: number) => "\u2500".repeat(n + 2);
  return `${left}${hbar(varWidth)}${mid}${hbar(statusWidth)}${mid}${hbar(reasonWidth)}${right}`;
}

function row(
  variable: string,
  status: string,
  reason: string,
  varWidth: number,
  statusWidth: number,
  reasonWidth: number,
  isStatusColored: boolean,
  color: boolean,
): string {
  const v = padEndVisual(variable, varWidth);
  const s = padEndVisual(status, statusWidth);
  const r = padEndVisual(reason, reasonWidth);
  const sColored = isStatusColored && status.length > 0 ? red(color, s) : s;
  return `\u2502 ${v} \u2502 ${sColored} \u2502 ${r} \u2502`;
}

/**
 * Visual-width-aware right-pad. Treats the `❌` emoji as two columns
 * (matching how most monospace fonts render it), keeping the table's
 * vertical bars aligned.
 */
function padEndVisual(s: string, width: number): string {
  const w = visualWidth(s);
  if (w >= width) return s;
  return s + " ".repeat(width - w);
}

function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    // The cross-mark emoji renders as two columns under fixed-width
    // terminal fonts. Other characters in our table are ASCII.
    w += ch === "\u274c" ? 2 : 1;
  }
  return w;
}

/**
 * Wrap `text` to a max visual width. Greedy word-wrap; long runs of
 * non-space characters are hard-broken at the boundary.
 */
function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  const words = text.split(/\s+/);
  let line = "";
  for (const word of words) {
    if (word.length === 0) continue;
    if (line.length === 0) {
      if (word.length <= width) {
        line = word;
      } else {
        // Hard-break a single long word.
        let remaining = word;
        while (remaining.length > width) {
          out.push(remaining.slice(0, width));
          remaining = remaining.slice(width);
        }
        line = remaining;
      }
      continue;
    }
    if (line.length + 1 + word.length <= width) {
      line += " " + word;
    } else {
      out.push(line);
      if (word.length <= width) {
        line = word;
      } else {
        let remaining = word;
        while (remaining.length > width) {
          out.push(remaining.slice(0, width));
          remaining = remaining.slice(width);
        }
        line = remaining;
      }
    }
  }
  if (line.length > 0) out.push(line);
  if (out.length === 0) out.push("");
  return out;
}

const ANSI_RED = "\u001b[31m";
const ANSI_RESET = "\u001b[0m";

function red(enabled: boolean, s: string): string {
  return enabled ? `${ANSI_RED}${s}${ANSI_RESET}` : s;
}

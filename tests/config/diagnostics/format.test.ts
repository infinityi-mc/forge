import { describe, expect, test } from "bun:test";
import { formatDiagnostics } from "../../../src/config/diagnostics/format";

describe("formatDiagnostics", () => {
  test("renders the header line and aggregates multiple issues into a table", () => {
    const output = formatDiagnostics([
      {
        path: "app.env",
        envVar: "APP_ENV",
        status: "missing",
        reason: "Must be one of: development, staging, production.",
      },
      {
        path: "db.url",
        envVar: "DB_URL",
        status: "invalid",
        reason: "Invalid URL.",
      },
    ]);
    expect(output).toContain("Forge Configuration Error");
    expect(output).toContain("APP_ENV");
    expect(output).toContain("DB_URL");
    expect(output).toContain("Missing");
    expect(output).toContain("Invalid");
    expect(output).toContain("Process exited with code 1.");
  });

  test("wraps long reasons across multiple lines without breaking the box", () => {
    const output = formatDiagnostics(
      [
        {
          path: "app.env",
          envVar: "APP_ENV",
          status: "missing",
          reason:
            "Must be one of: alpha, beta, gamma, delta, epsilon — a very long reason.",
        },
      ],
      { width: 80 },
    );
    const tableLines = output.split("\n").filter((l) => l.startsWith("\u2502"));
    // Box should be consistent — every body line ends with the right
    // vertical bar.
    for (const line of tableLines) {
      expect(line.endsWith("\u2502")).toBe(true);
    }
    // Multiple wrap lines for the long reason.
    expect(tableLines.length).toBeGreaterThanOrEqual(3);
  });

  test("color=true emits ANSI red around the header and status cells", () => {
    const output = formatDiagnostics(
      [
        {
          path: "app.env",
          envVar: "APP_ENV",
          status: "missing",
          reason: "missing",
        },
      ],
      { color: true },
    );
    expect(output).toContain("\u001b[31m");
    expect(output).toContain("\u001b[0m");
  });

  test("color=false (default) emits no ANSI escapes", () => {
    const output = formatDiagnostics([
      {
        path: "app.env",
        envVar: "APP_ENV",
        status: "missing",
        reason: "missing",
      },
    ]);
    expect(output).not.toContain("\u001b[");
  });

  test("table never exceeds the requested width", () => {
    for (const width of [60, 72, 80, 100, 120]) {
      const output = formatDiagnostics(
        [
          {
            path: "app.env",
            envVar: "APP_ENV",
            status: "missing",
            reason:
              "Must be one of: alpha, beta, gamma, delta, epsilon — a very long reason that forces wrapping.",
          },
          {
            path: "db.url",
            envVar: "DB_URL",
            status: "invalid",
            reason: "Invalid URL.",
          },
        ],
        { width },
      );
      const boxLines = output
        .split("\n")
        .filter(
          (l) =>
            l.startsWith("\u250c") ||
            l.startsWith("\u251c") ||
            l.startsWith("\u2514") ||
            l.startsWith("\u2502"),
        );
      for (const line of boxLines) {
        // Visual width = code-point count (every char in the rendered
        // table is single-column once the emoji-pad accounting in
        // `padEndVisual` is applied). The renderer must respect the
        // user-supplied budget.
        const charLen = [...line].length;
        expect(charLen).toBeLessThanOrEqual(width);
      }
    }
  });
});

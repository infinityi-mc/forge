import { existsSync, readFileSync } from "node:fs";

type PackageJson = {
  main?: string;
  module?: string;
  types?: string;
  exports?: unknown;
};

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
const missing = new Set<string>();

function assertDistFile(path: string): void {
  if (path.startsWith("./dist/") && !existsSync(path)) {
    missing.add(path);
  }
}

function visitExportTarget(value: unknown): void {
  if (typeof value === "string") {
    assertDistFile(value);
    return;
  }

  if (value && typeof value === "object") {
    for (const next of Object.values(value)) {
      visitExportTarget(next);
    }
  }
}

assertDistFile(packageJson.main ?? "");
assertDistFile(packageJson.module ?? "");
assertDistFile(packageJson.types ?? "");
visitExportTarget(packageJson.exports);

if (missing.size > 0) {
  console.error("Missing package entry files:");
  for (const path of [...missing].sort()) {
    console.error(`- ${path}`);
  }
  process.exit(1);
}

console.log("all package entry files exist");

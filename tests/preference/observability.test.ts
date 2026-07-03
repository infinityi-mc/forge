import { describe, expect, test } from "bun:test";
import { Secret } from "../../src/config/secret";
import {
  definePreferences,
  memoryStore,
  t,
  type LogAttributes,
} from "../../src/preference";

interface RecordedLine {
  readonly level: "info" | "warn" | "error";
  readonly msg: string;
  readonly attrs?: LogAttributes;
}

function recordingLogger() {
  const lines: RecordedLine[] = [];
  return {
    lines,
    info: (msg: string, attrs?: LogAttributes) =>
      lines.push({ level: "info", msg, attrs }),
    warn: (msg: string, attrs?: LogAttributes) =>
      lines.push({ level: "warn", msg, attrs }),
    error: (msg: string, attrs?: LogAttributes) =>
      lines.push({ level: "error", msg, attrs }),
  };
}

const schema = {
  appearance: {
    theme: t.enum(["light", "dark", "system"] as const).default("system"),
    fontSize: t.number.int.default(14),
  },
  editor: {
    autosave: t.boolean.default(true),
  },
  auth: {
    token: t.secret.default(new Secret("default-secret")),
  },
};

describe("preference observability", () => {
  test("load summary includes paths and fallback keys without values", async () => {
    const logger = recordingLogger();
    await definePreferences(schema, {
      store: memoryStore({
        "appearance.theme": "neon",
        "appearance.fontSize": 18,
        "auth.token": "stored-secret",
      }),
      logger,
    });

    expect(logger.lines).toHaveLength(1);
    const [line] = logger.lines;
    expect(line).toMatchObject({
      level: "info",
      msg: "Preferences loaded",
    });
    expect(line!.attrs).toMatchObject({
      module: "forge/preference",
      stores: ["memory"],
      scopes: [{ store: "memory" }],
      loaded_keys: [
        "appearance.theme",
        "appearance.fontSize",
        "editor.autosave",
        "auth.token",
      ],
      fallback_keys: ["appearance.theme"],
    });
    expect(typeof line!.attrs!["load_time_ms"]).toBe("number");
    const encoded = JSON.stringify(line);
    expect(encoded).not.toContain("neon");
    expect(encoded).not.toContain("stored-secret");
    expect(encoded).not.toContain("default-secret");
    expect(encoded).not.toContain("[REDACTED]");
  });

  test("save logs include store, scope, keys, and version", async () => {
    const logger = recordingLogger();
    const user = memoryStore({}, { name: "user-store" });
    const workspace = memoryStore({}, { name: "workspace-store" });
    const prefs = await definePreferences(schema, {
      scopes: { user, workspace },
      version: 2,
      logger,
    });

    await prefs.set("appearance.theme", "dark", { scope: "user" });

    const save = logger.lines.find((line) => line.msg === "Preferences saved");
    expect(save).toMatchObject({
      level: "info",
      attrs: {
        module: "forge/preference",
        store: "user-store",
        scope: "user",
        saved_keys: ["appearance.theme"],
        version: 2,
      },
    });
  });

  test("external reload logs changed and fallback keys", async () => {
    const logger = recordingLogger();
    const store = memoryStore({ "appearance.theme": "light" });
    const prefs = await definePreferences(schema, { store, logger });

    store.replace({
      "appearance.theme": "dark",
      "appearance.fontSize": "huge",
    });
    await prefs.flush();

    const reload = logger.lines.find(
      (line) => line.msg === "Preferences externally reloaded",
    );
    expect(reload).toMatchObject({
      level: "warn",
      attrs: {
        module: "forge/preference",
        store: "memory",
        changed_keys: ["appearance.theme"],
        fallback_keys: ["appearance.fontSize"],
      },
    });
  });

  test("migration logs include from/to versions and applied hooks", async () => {
    const logger = recordingLogger();
    await definePreferences(schema, {
      store: memoryStore({
        $version: 1,
        "editor.autoSave": false,
      }),
      version: 2,
      migrations: {
        2: (snapshot) => ({
          ...snapshot,
          "editor.autosave": snapshot["editor.autoSave"],
        }),
      },
      logger,
    });

    const migration = logger.lines.find(
      (line) => line.msg === "Preferences migrated",
    );
    expect(migration).toMatchObject({
      level: "info",
      attrs: {
        module: "forge/preference",
        store: "memory",
        from_version: 1,
        to_version: 2,
        migration_versions: [2],
      },
    });
  });

  test("logger failures are isolated from preference operations", async () => {
    const logger = {
      info: () => {
        throw new Error("logger failed");
      },
      warn: () => {
        throw new Error("logger failed");
      },
      error: () => {
        throw new Error("logger failed");
      },
    };
    const prefs = await definePreferences(schema, {
      store: memoryStore(),
      logger,
    });

    await prefs.set("appearance.theme", "dark");

    expect(prefs.values.appearance.theme).toBe("dark");
  });
});

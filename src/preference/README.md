# forge/preference

User-owned, runtime-mutable, fail-safe settings. `forge/preference` is the product-layer sibling of `forge/config`: it reuses the same schema builder, but bad user data never crashes the app. Invalid leaves fall back independently to defaults or `undefined`, writes are validated before persistence, and durable stores keep explicit values only.

---

## Features

- **`definePreferences(schema, options)`** - async load, fail-safe validate, freeze, and return a live values handle.
- **`set`, `update`, `reset`, `resetAll`, and `isSet`** - validated write APIs over the explicit-values model.
- **Stores** - `memoryStore`, `jsonFileStore`, `sqliteStore`, plus the `PreferenceStore` interface for custom stores.
- **Scopes** - ordered user/workspace/device layers where later scopes win.
- **Versioning** - persisted `$version`, ordered migrations, unknown-key preservation, and migration diagnostics.
- **Observability** - optional structural logger lines for load, save, external reload, and migration events.
- **Testing** - `mockPreferences`, `memoryStore`, and store conformance helpers from `forge/preference/testing`.

---

## Quick Start

```ts
import {
  definePreferences,
  jsonFileStore,
  t,
} from "@infinityi/forge/preference";

export const prefs = await definePreferences(
  {
    appearance: {
      theme: t.enum(["light", "dark", "system"] as const).default("system"),
      fontSize: t.number.int.default(14),
    },
    editor: {
      autosave: t.boolean.default(true),
      recentFiles: t.json<readonly string[]>().default([]),
    },
  },
  {
    store: jsonFileStore({ path: "./preferences.json", debounceMs: 250 }),
    logger: console,
  },
);

prefs.values.appearance.theme; // "light" | "dark" | "system"

await prefs.set("appearance.theme", "dark");
await prefs.reset("appearance.fontSize");
await prefs.flush();
```

Every leaf must declare `.default(...)` or `.optional()`. That is the contract that makes the read path fail-safe.

---

## Persistence Model

Stores persist only explicit values keyed by dotted schema path:

```json
{
  "appearance.theme": "dark"
}
```

The live view is `defaults + explicit`. Resetting deletes an explicit value, so future shipped-default changes take effect for users who never overrode that setting.

Built-in stores:

- `memoryStore(initial?)` - in-memory test/local store with watch support.
- `jsonFileStore({ path, debounceMs?, watch? })` - atomic JSON file writes with optional external reloads.
- `sqliteStore({ path | database, table? })` - transactional key/value rows in `bun:sqlite`.

Custom stores implement:

```ts
interface PreferenceStore {
  readonly name: string;
  load(): Promise<PreferenceSnapshot | undefined>;
  save(snapshot: PreferenceSnapshot): Promise<void>;
  watch?(onExternalChange: (snapshot: PreferenceSnapshot) => void): () => void;
  flush?(): Promise<void>;
  shutdown?(): Promise<void>;
}
```

---

## Scopes And Versioning

Use `scopes` when preferences are layered. Object insertion order defines precedence; later scopes win.

```ts
const prefs = await definePreferences(schema, {
  scopes: {
    user: jsonFileStore({ path: userPath }),
    workspace: jsonFileStore({ path: workspacePath }),
  },
  version: 2,
  migrations: {
    2: (raw) => ({
      ...raw,
      "editor.autosave": raw["editor.autoSave"] ?? raw["editor.autosave"],
    }),
  },
});

await prefs.set("editor.autosave", false, { scope: "workspace" });
```

Unscoped writes target the highest-precedence scope. `isSet(path)` checks the effective merged explicit value; `isSet(path, { scope })` checks one scope.

Persisted versions use the reserved `$version` key. Unknown keys are preserved across loads, migrations, external reloads, and later saves so downgrade/upgrade cycles do not destroy future data.

---

## Observability

Pass `logger` to receive structural log lines. The logger is the same tiny structural shape used by `forge/config`: `info`, `warn`, and `error` methods accepting `(msg, attrs)`. Preference values are never logged.

```ts
await definePreferences(schema, { store, logger: console });
// info "Preferences loaded" {
//   module: "forge/preference",
//   load_time_ms: 2,
//   stores: ["json-file"],
//   scopes: [{ store: "json-file" }],
//   loaded_keys: ["appearance.theme", "editor.autosave"],
//   fallback_keys: [],
// }
```

Emitted events:

- `Preferences loaded` - load summary with `loaded_keys` and `fallback_keys`.
- `Preferences saved` - store/scope and explicit `saved_keys` after a successful save.
- `Preferences externally reloaded` - store/scope, effective `changed_keys`, and fallback keys after a watched store update.
- `Preferences migrated` - store/scope, `from_version`, `to_version`, and applied migration hook versions.

Logger failures are isolated and never change preference behavior.

---

## Testing

`forge/preference/testing` provides async-scoped value overrides plus store helpers.

```ts
import { mockPreferences } from "@infinityi/forge/preference/testing";

await mockPreferences({ appearance: { theme: "dark" } }, async () => {
  prefs.values.appearance.theme; // "dark" inside this async scope
});

prefs.values.appearance.theme; // original value after the scope settles
```

`mockPreferences` does not write to the backing store. Nested mocks compose with last write wins, parallel async scopes are isolated, and mocked subtrees remain read-only.

Store authors can validate custom stores with `assertPreferenceStoreConformance` from the same testing entrypoint.

---

## Lifecycle

Preference handles expose `flush()`, `shutdown()`, and `[Symbol.asyncDispose]()`.

```ts
await prefs.flush();
await prefs.shutdown();
// TS 5.2+: await using prefs = await definePreferences(...)
```

`shutdown()` is idempotent: it drains pending writes, unsubscribes external watchers, releases store resources, and rejects future writes.

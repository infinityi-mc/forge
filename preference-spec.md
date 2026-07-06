# `forge/preference` — Design Spec & Implementation Plan

User-owned, runtime-mutable, fail-*safe* settings. The product-layer sibling of `forge/config`.

This document covers:

1. The core differences between **configuration** and **preference**.
2. Why building a preference system from scratch is harder than it looks.
3. What Forge will provide to solve that difficulty.
4. A minimum API contract for `forge/preference`.
5. A PR-based implementation plan.

---

## 1. Configuration vs. Preference

Both are "key/value settings", which is why they get conflated. Their *lifecycles* are opposites:

| Dimension | Configuration (`forge/config`) | Preference (`forge/preference`) |
| :--- | :--- | :--- |
| **Owner** | Developer / operator | End user |
| **Decides** | *How the app runs in an environment* | *How the app behaves for me* |
| **Changed by** | Deploys, env vars, ops tooling | In-app user actions, at runtime |
| **Change frequency** | Per deploy / per environment | Any time while the app is running |
| **Source of truth** | Environment (12-Factor), dynamic providers | User-owned file / database row |
| **Direction** | Read-only from the app's perspective | Read **and write** from the app |
| **Failure policy** | **Fail-fast at boot** — a bad value must crash the process before it serves traffic | **Fall back safely** — a bad or missing value silently reverts to its default; the app must never crash |
| **Scope** | Per environment / per process | Per user, per device, per workspace |
| **Secrets** | Common (`Secret<T>`, redaction) | Rare; prefs are user data, not credentials |
| **Belongs to** | Infrastructure / operations | Product / user experience |

The failure-policy row is the philosophical fork. `forge/config`'s pillar is *Fail-Fast at Boot* (README Design Principle 5): a missing `DB_URL` should kill the process in milliseconds. A preference is the exact inverse: a corrupt `theme` value in `preferences.json` must **never** take the app down — it should quietly become `"system"` again. Same schema machinery, opposite failure posture. That is why preferences deserve a dedicated module rather than a flag on `defineConfig`.

---

## 2. Why "just write a JSON file" is harder than it looks

Every team that builds file-based preferences from scratch rediscovers the same traps:

1. **Torn writes.** A crash or power loss mid-`writeFile` leaves a half-written JSON file. Next boot: `SyntaxError: Unexpected end of JSON input` — and if the developer didn't wrap the read, the app crashes on the *user's* machine with no operator around to fix it. Correct persistence is write-to-temp-file + `fsync` + atomic `rename`.
2. **Partial validity.** One stale or hand-edited leaf (`"fontSize": "big"`) should not discard the user's 30 other valid preferences. Naive `parse → validate whole object → throw` does exactly that. You need *per-leaf* fallback: keep what parses, reset what doesn't.
3. **Defaults layering & reset.** "Reset to default" requires distinguishing *the user explicitly set X* from *X is currently its default value* — which means persisting only explicit values, not the merged view. Most hand-rolled systems persist the merged snapshot and can never cleanly reset or change a shipped default again.
4. **Schema evolution.** v2 of the app renames `editor.autoSave` → `editor.autosave`. Old files must migrate forward, unknown keys must be tolerated (the user may downgrade), and none of this may crash.
5. **Concurrency.** Two windows / processes of the same app writing the same file; a sync client or the user editing the file externally. You need last-write-wins with change detection at minimum, and a subscription mechanism so open UI reflects external changes.
6. **Write amplification.** A slider firing 60 change events per second must not issue 60 disk writes. Persistence needs debouncing plus an explicit `flush()` for clean shutdown.
7. **Cross-platform paths.** `~/.config` vs `%APPDATA%` vs `~/Library/Application Support`, plus per-workspace files. Trivial, tedious, and always wrong on one platform.
8. **Testability.** Tests must not touch the real user's preference file, and must be able to simulate corrupt files, migrations, and concurrent external edits deterministically.

Each item is a solved problem. Solving all eight, correctly, under product-deadline pressure is the "infrastructure tax" Forge exists to eliminate.

---

## 3. What Forge provides

`forge/preference` reuses the proven `forge/config` machinery and inverts the failure policy:

- **Same schema language.** The `t` builder (`t.enum`, `t.number.int`, `t.boolean`, `t.json<T>()`, `.default(...)`) is reused verbatim. Types are inferred end-to-end; every leaf **must** declare a `.default(...)` (or `.optional()`) — compile-time enforcement that a fallback always exists.
- **Fail-safe validation.** The shared validator core (`src/config/validate.ts`) runs per-leaf. Invalid or missing leaves fall back to their default and are reported as structured, non-fatal diagnostics (`onDiagnostic` / logger) — never `process.exit`, never a throw on the read path.
- **Atomic, debounced persistence.** Built-in stores handle temp-file + `rename` atomic writes, corrupt-file recovery, debounced saves, and `flush()` on shutdown.
- **Bun-first stores** (Design Principle 1): `jsonFileStore` on `Bun.file` / `Bun.write`, `sqliteStore` on `bun:sqlite`. No third-party runtime deps.
- **Interfaces first** (Principle 3): `PreferenceStore` is a tiny interface; `memoryStore` ships for tests; BYO store for Postgres, cloud sync, etc. A store conformance suite validates custom implementations, mirroring `assertProviderConformance`.
- **Explicit-values model.** Only user-set values are persisted; the live view is `defaults ⊕ explicit`. `reset()` is deletion, and shipped-default changes take effect for users who never overrode them.
- **Change subscription & atomic swap.** Reuses the dynamic-config proxy pattern: `prefs.values` always reads the latest deep-frozen snapshot; `subscribe` fires with `(old, next, changedKeys)`.
- **Scopes.** Layered resolution across `user` / `workspace` (workspace wins), each backed by its own store.
- **Migrations.** A persisted `version` plus ordered `migrations` hooks; unknown keys are preserved, failed migrations fall back to defaults with a diagnostic.
- **Observable by default** (Principle 4): structural `Logger` (same as `forge/config`), structured lines for load, fallback events, saves, and external reloads.
- **Testing:** `forge/preference/testing` with `memoryStore`, `mockPreferences` (ALS-scoped, mirrors `mockConfig`), and the store conformance scenarios.

Out of scope (module constraints): no cloud-sync protocol, no UI/settings-screen generation, no cross-device conflict resolution (CRDTs) — stores are the seam where applications plug those in.

---

## 4. Minimum API contract

```ts
import { definePreferences, t, jsonFileStore } from "@infinityi/forge/preference";

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
    store: jsonFileStore({ path: prefsPath, debounceMs: 250 }),
    version: 2,
    migrations: {
      2: (raw) => ({ ...raw, "editor.autosave": raw["editor.autoSave"] ?? raw["editor.autosave"] }),
    },
    logger,                            // optional, structural Logger
    onDiagnostic(d) { /* invalid leaf fell back — non-fatal */ },
  },
);

// ── Read (typed, live view — same proxy semantics as defineDynamicConfig) ──
prefs.values.appearance.theme;         // "light" | "dark" | "system"
prefs.values.editor.recentFiles;       // readonly string[]

// ── Write (validated; invalid value throws PreferenceValidationError to the *caller*, never crashes reads) ──
await prefs.set("appearance.theme", "dark");        // dotted path, value type-checked against the leaf
await prefs.update((v) => ({ editor: { recentFiles: [...v.editor.recentFiles, file] } }));

// ── Reset (deletes the explicit value; default shows through) ──
await prefs.reset("appearance.fontSize");
await prefs.resetAll();
prefs.isSet("appearance.fontSize");    // false — currently the shipped default

// ── Observe ──
const unsubscribe = prefs.subscribe((old, next, changedKeys) => {
  render(next);
});

// ── Lifecycle ──
await prefs.flush();                   // force pending debounced write
await prefs.shutdown();                // flush + release store; safe to call twice
// TS 5.2+: await using prefs = await definePreferences(...)
```

### `PreferenceStore` interface (the BYO seam)

```ts
/** Snapshot keyed by dotted schema path — same shape as DynamicConfigSnapshot. */
type PreferenceSnapshot = Record<string, unknown>;

interface PreferenceStore {
  readonly name: string;
  load(): Promise<PreferenceSnapshot | undefined>;   // undefined ⇒ first run
  save(snapshot: PreferenceSnapshot): Promise<void>; // must be atomic
  watch?(onExternalChange: (snapshot: PreferenceSnapshot) => void): () => void;
  shutdown?(): Promise<void>;
}
```

Built-ins: `jsonFileStore({ path, debounceMs?, watch? })` (relative paths resolve from the current working directory), `sqliteStore({ path | database, table? })`, `memoryStore(initial?)` (testing).

### Error taxonomy

`PreferenceError` base + `PreferenceValidationError` (thrown only from `set`/`update` — the write path), `PreferenceStoreError`, `PreferenceSchemaError` (schema missing a default — thrown at `definePreferences`, the one legitimately fail-fast moment since it is a programmer error, not user data).

### Scopes (layered)

```ts
const prefs = await definePreferences(schema, {
  scopes: {
    user: jsonFileStore({ path: userPath }),
    workspace: jsonFileStore({ path: wsPath }),   // later entries win
  },
});
await prefs.set("editor.autosave", false, { scope: "workspace" });
```

---

## 5. PR-based implementation plan

Five PRs, each independently reviewable, shippable, and fully tested (`bun test`, `bun run check`, `bun run build` green at every step).

### PR A — Core: schema reuse, fail-safe validation, read path
- `src/preference/{index,types,errors}.ts`; re-export `t` from the shared schema builder.
- `PreferenceSchema` type requiring `.default()`/`.optional()` on every leaf (compile-time).
- Fail-safe validator wrapping `src/config/validate.ts`: per-leaf fallback + `PreferenceDiagnostic[]`, no exit/throw on read.
- `definePreferences(schema, { store })` — load → migrate-less validate → deep-freeze → `values` live-view proxy (reuse `dynamic/proxy.ts` pattern).
- `PreferenceStore` interface + `memoryStore`.
- Package: `./preference` subpath export; tests in `tests/preference/`.

### PR B — Write path: set / update / reset, subscription, lifecycle
- `set(path, value)` with typed dotted-path inference; `update(fn)`; `reset(path)` / `resetAll()` / `isSet(path)` on the explicit-values model.
- Validate-on-write (`PreferenceValidationError` to caller), atomic snapshot swap, `subscribe(old, next, changedKeys)` with isolated handler errors (reuse `dynamic/diff.ts`).
- `flush()`, `shutdown()`, `[Symbol.asyncDispose]`.

### PR C — Durable stores: JSON file + SQLite
- `jsonFileStore`: `Bun.file`/`Bun.write`, temp-file + atomic `rename`, corrupt-file recovery (rename aside to `.corrupt`, diagnostic, defaults), `debounceMs`, optional `watch` for external edits with reconcile-and-notify.
- `sqliteStore`: `bun:sqlite` key/value table, transactional save.
- Store conformance suite in `src/preference/testing/conformance.ts` (atomicity, first-run `undefined`, watch semantics); both built-ins pass it.

### PR D — Versioning & scopes
- Persisted `version` + ordered `migrations` map; unknown-key preservation; failed migration ⇒ defaults + diagnostic.
- Layered `scopes` resolution (later wins), per-scope `set`/`reset`, merged live view and merged change events.

### PR E — Observability, testing helpers, docs
- Structured logger lines: load summary (`loaded_keys`, `fallback_keys`), save, external reload, migration — mirroring `src/config/observability.ts`.
- `mockPreferences` (ALS-scoped overrides, mirrors `mockConfig`); export `forge/preference/testing`.
- `src/preference/README.md`, root README module table row, `EXAMPLES.md` entry, CHANGELOG.

Dependency order: A → B → C → (D, E can land in either order after C).

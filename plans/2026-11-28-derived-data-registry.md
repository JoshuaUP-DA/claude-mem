# Design: one progress ledger for claude-mem's derived indexes

**Date:** 2026-11-28
**Status:** Design only, for proposal to upstream `thedotmack/claude-mem`. Not implemented in this fork, on purpose: the code it touches changes upstream almost daily, so a fork-only rewrite would conflict with every update.
**Based on:** upstream `main` at v17.0.2 (`ad682a3`), not this fork's v15.7.0. Re-check the anchors below against upstream before opening a PR, because they move fast.
**Parent plan:** `plans/2026-11-18-agent-scale-memory.md`, Phase 2.

## Why

Scion, Anthropic's source control system, computes everything that isn't the raw change through **one generic mechanism**. Each kind of derived data is defined from its inputs, marked eager or lazy, and versioned, so adding an index costs one definition, not a new pipeline. claude-mem builds four derived indexes from its rows, and each one tracks "what's done" in its own way.

## What exists today (upstream v17.0.2)

| Index | Built from | When | How it tracks progress | How it rebuilds after a format change |
|---|---|---|---|---|
| FTS5 full-text | observations, summaries, prompts | Same transaction, via SQLite triggers | Nothing to track: the triggers can't fall behind | Schema migration |
| `observation_files` (path → observation) | `files_read`, `files_modified` | Same transaction, via `replaceObservationFileIndex` (`src/services/sqlite/observations/files.ts`), called from `SessionStore` and twice from `SyncApply` | Nothing to track; a writer that forgets the call leaves the row "permanently unsearchable by file" (the function's own comment) | A one-shot migration (v68) that is stamped and never runs again |
| Chroma embeddings | observations, summaries, prompts | After the write, by backfill | `chroma-sync-state.json`: per-project, per-kind max-id watermarks, `pending` id lists, `fragmentReconciliation`, a separate list of pending row deletes, and flags (`titleOnlyRequeued`, `rebuildPending`). Writes are coalesced on a timer because per-row rewrites grew quadratically (#6203) | Ad hoc: a flag per historical fix (`titleOnlyRequeued` for #4069, `rebuildPending` for #3202) |
| SessionStart context cache | everything that feeds the context block | Event-driven: writers call `emitContextInvalidation`, and a debounced re-render writes cache files | An in-process generation counter; cached files expire after 24 h | Not versioned: a renderer change relies on invalidation or expiry |

**What's actually inconsistent:**
- Only Chroma can fall behind, and it's the one index whose progress lives outside SQLite, in a JSON file that has needed backoff, coalescing and retry logic (#5664, #6203) to stay correct.
- Each format change to an index has added a new one-off mechanism: a flag, a stamped migration, or a requeue.
- No single place answers "is every index caught up for project X, and if not, how far behind?"

## What I'd change

The narrow version, which is the one worth proposing first:

### 1. Move Chroma's progress from the JSON file into SQLite

```sql
CREATE TABLE derived_progress (
  index_name   TEXT    NOT NULL,   -- 'chroma'
  index_version INTEGER NOT NULL,  -- bump to force a rebuild
  project      TEXT    NOT NULL,
  row_kind     TEXT    NOT NULL,   -- 'observations' | 'summaries' | 'prompts'
  watermark    INTEGER NOT NULL DEFAULT 0,  -- highest row id fully indexed
  updated_at_epoch INTEGER NOT NULL,
  PRIMARY KEY (index_name, project, row_kind)
);

CREATE TABLE derived_pending (
  index_name TEXT    NOT NULL,
  row_kind   TEXT    NOT NULL,
  row_id     INTEGER NOT NULL,
  reason     TEXT    NOT NULL,     -- 'retry' | 'reconcile_fragments' | 'delete'
  attempts   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (index_name, row_kind, row_id, reason)
);
```

- **Pending work becomes rows, not a rewritten array.** Marking or clearing one row is one small write, so the quadratic-rewrite problem (#6203) and the coalescing timer go away.
- **A row write can enqueue its own index work in the same transaction.** Today the JSON file can disagree with SQLite after a crash. Chroma itself is still written outside the transaction; that doesn't change.
- **`index_version` replaces the one-off flags.** When the stored version is lower than the code's, the runner resets that index's watermarks to 0 and rebuilds in the background, replacing `titleOnlyRequeued` / `rebuildPending`-style flags for future fixes. The existing flags are read once during migration and then retired.
- **Migration:** read `chroma-sync-state.json` once, copy its watermarks and pending lists into the tables, and rename the file to `.migrated`. If the file is missing or corrupt, start at watermark 0, which is today's behavior for a dropped collection.

### 2. A small `DerivedIndex` interface, with Chroma as its only first user

```ts
interface DerivedIndex {
  name: string;               // 'chroma'
  version: number;            // bump to rebuild
  rowKinds: RowKind[];        // which tables feed it
  mode: 'eager' | 'deferred'; // eager = same transaction; deferred = backfill runner
  index(kind: RowKind, rows: Row[]): Promise<void>;
  remove(kind: RowKind, ids: number[]): Promise<void>;
}
```

One backfill runner walks `derived_progress` / `derived_pending` for every deferred index. The next index (exact-path matching, copy detection, a second embedding model) is then one definition.

### Deliberately out of scope

- **FTS5 and `observation_files` stay as they are.** They are eager, in-transaction and can't lag. Wrapping them adds indirection for no gain. The one real risk, a writer forgetting `replaceObservationFileIndex`, is better caught by a test that every observation insert/update path calls it.
- **The context cache stays event-driven.** It's a rendered-output cache, not an index over rows, and its invalidation model (`additive` / `removal`) fits that. Adding a renderer version to its file key would fix the "renderer changed, cache didn't" gap more cheaply than the registry would.
- **No server-side (Postgres) changes.** The hosted server has its own embedding pipeline. Unify the local one first.

## Expected benefit, honestly

- **Today:** fewer moving parts in Chroma sync (no JSON persistence, backoff or coalescing), crash-consistent pending work, and one query for "how far behind is indexing", which a health check or watcher can read.
- **Later:** adding a derived index becomes one interface implementation. That only pays off if more indexes are coming. Scion added several, and claude-mem's plans mention copy detection and exact path search, but upstream should judge whether those are planned.
- **Cost:** a migration of user state on every install, and a rewrite of the progress-tracking half of `ChromaSync.ts` (about 2,900 lines upstream). That needs the upstream maintainer's buy-in and their test harness, which is why this is a proposal and not a fork change.

## How to propose it

1. Open a discussion or issue on `thedotmack/claude-mem` with sections 1–2 above, linking #5664 and #6203 as the motivation.
2. If accepted, the first PR is section 1 only (tables, migration, Chroma reading and writing them), behind the existing Chroma tests plus a migration test from a real `chroma-sync-state.json`.
3. Section 2 (the interface) follows only when a second deferred index is actually being built.

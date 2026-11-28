# Agent-Scale Memory: Applying the Scion Principles to claude-mem

**Date:** 2026-11-18
**Status:** Proposed. Owner decisions recorded in §5. **Phase 1 withdrawn 2026-11-24** (see the correction under Gap A). **Phase 3 done 2026-11-25** (it was mostly built already; this PR exposes it to agents). **2026-11-28:** Phase 2 is a design for upstream, Phase 4 already exists, Phase 5 is an upstream drift watcher. See §6 for what changed: this repo is a fork of `thedotmack/claude-mem` and is 46 releases behind it.
**Source:** Anthropic's write-up on Scion, the in-house source control system it built after merges went from ~2,500/day to 30,000+/day. Scion's lesson is that tools sized for humans break once agents become most of the clients, and that the fix is to design for clients that are *always online, numerous, and short-lived*.

claude-mem is heading into the same pattern. Memory writes used to come from one person at one terminal. They now come from agents running in parallel, cloud sandboxes (Claude Code on the web, Claude Tag, CI), and up to 64 devices per account. Every one of those is online, and most are ephemeral. This plan maps each Scion principle onto what claude-mem already has, names the gaps, and orders the work.

---

## 1. Where we already match Scion

Most of the data model is already right. That should stay, not be rebuilt.

| Scion principle | claude-mem today | Anchor |
|---|---|---|
| Unit of work is an append-only changeset in a write-ahead log | SyncHub is a per-user ordered op log with a monotonic `seq` and cursor pulls | `services/sync-api/src/store.ts`, `docs/public/cloud-sync.mdx` |
| Content-addressed, immutable data that any tier can cache | Observations dedupe on content hash; canonical bodies are content-hashed | `src/services/sync/CanonicalContent.ts`, `storeObservations` `ON CONFLICT DO NOTHING` |
| No refs to coordinate; writes don't move global pointers | Idempotent push keyed on origin identity; no global branch state | `pushOps` in `store.ts` |
| Durable truth over HTTP; anything faster is advisory | Two-lane sync: HTTP cursor is the truth, the WebSocket only nudges | `plans/2026-07-17-phase5-two-lane-sync.md` |
| Server-side query API | Recall MCP server: `search`, `timeline`, `get_observations`, `context`, `recent` | `src/server/mcp/recall-mcp-server.ts` |
| Hosting off metered compute | `sync.cmem.ai` runs on Fly and forwards to the Supabase `cmem-sync` function; nothing on Cloudflare compute | `services/sync-api/fly.toml`, `services/sync-api/src/forward.ts` |

## 2. Gaps, ranked by leverage

### Gap A: a push can't succeed until projection catches up (withdrawn; already fixed by the Supabase cutover)

> **Correction, 2026-11-24.** This gap was written from the Fly hub's code without checking which mode production runs in. Production `sync.cmem.ai` runs in **forward mode**: `GET /v1/sync/ws` answers `410 {"error":"websocket_retired"}`, a response only `services/sync-api/src/forward.ts` produces. Every `/v1/sync/*` request goes to the Supabase `cmem-sync` function, which appends to the log and writes the searchable rows in one transaction, so `projected_seq == head_seq` always (`plans/2026-10-03-liveness-over-deadlines.md`, Track B). The hub-mode `drainProjection` path described below serves no traffic, and Phase 12 step 8 of that plan deletes it. Phase 1 is withdrawn. What still applies is in the follow-ups at the end of Phase 1.


Scion requires that *"the cost of creating a commit… scale with the size of the change, not the overall size of the repo,"* and it computes everything downstream as **derived data**, eagerly or deferred, apart from the write.

Our hub ties the two together. `POST /v1/sync/push` writes the ops durably, then **awaits `drainProjection`** before replying (`services/sync-api/src/index.ts:185-208`). When projection is behind or leased by another request, the client gets a `503` (`projection_catching_up` / `projection_busy`) even though the response says `durable: true`. The rest of the system has bent around this:

- Client batch size was cut from 200 to **40** because pushes timed out under `projection_busy` (`src/services/sync/CloudSync.ts:70-73`).
- Client request timeout was raised to **90 s** to outlast the projection lease (`CloudSync.ts:74-78`).
- The client keeps rows in the outbox until *projection* acknowledges them, so data that is already durable gets re-sent (`CloudSync.ts:1118-1121`).

The cost of a write therefore grows with the projection backlog, and every new agent adds to that backlog. This is the human-scale assumption that will break first.

### Gap B: each index is built its own way

FTS (SQLite triggers), Chroma embeddings (`ChromaSync` + `ChromaSyncState`), hub projection, session summaries, and the context cache each have their own pipeline, retry state, and catch-up logic. Scion uses **one generic mechanism**: each kind of derived data is defined from its parents, and each is marked eager or lazy. Adding a new index (copy detection, path search) then costs one definition, not a new pipeline.

### Gap C: cloud and ephemeral agents pay for a full local install

Scion's clients keep a bounded cache and ask the server for everything else, and *"the working copy is optional, and sparse by design."* A claude-mem client is a full peer: Bun worker, SQLite, a Chroma sidecar (via `uv`/Python), plus a pull of the whole history. That is reasonable for a laptop and wasteful for a sandbox that lives for 20 minutes. The recall MCP server and `src/server` already cover most of the read path; nothing sets up a client that *only* uses them.

### Gap D: missing queries that agents need *(mostly not a gap; see Phase 3)*

Scion's server answers blame and path history, so tools never need a local copy. The memory equivalent is "**which observations touched this file / this symbol, newest first**" (memory blame). The first draft said the recall API had no path-history query. In fact the local worker already had one (an indexed table, a by-file route, a `files` search filter and the File Read Gate). Only the MCP tool schema hid it. The hosted server's recall MCP still has no path filter.

### Gap E: the fleet is watched by alerts, not watchers

Scion's "superfans" are agents, each assigned to the health of one component. We already expose `/api/sync/status`, queue-health types, and PostHog telemetry. Nothing watches them continuously.

---

## 3. Phased plan

### Phase 1: Separate push acceptance from projection *(withdrawn; see the correction under Gap A)*

Goal: a push costs O(ops in the request) and returns `200` as soon as the ops are durable.

1. **Hub** (`services/sync-api/src/index.ts`): after `pushOps` succeeds, return `200 { head_seq, projected_seq, durable: true }` straight away. Start projection with a non-blocking kick (an in-process `user-queue.ts` job), not an `await`. Keep the lease and checkpoint code in `projection.ts` as it is; only the caller changes.
2. **Protocol:** add `projection_pending: boolean` to the push response so clients and `/v1/sync/status` can still report lag. Pulls already read `projected_seq`, so readers keep their guarantee.
3. **Client** (`CloudSync.ts`): mark outbox rows synced on `durable: true`, not on projection. Then re-test whether the batch size can go back up toward 200–500 and the timeout back down to ~30 s (measure first; don't just flip the constants).
4. **Tests:** extend `services/sync-api/test/lock-hold.test.ts` with a case where a slow projector must not slow pushes, and add a client test where a durable push with projection pending does not retry.
5. **Backward compatibility:** older clients that treat `503 durable:true` as retryable still converge, because push is idempotent. Nothing has to ship in lockstep.

**Exit criteria:** p99 push latency doesn't change as projection backlog grows; no `projection_busy` errors in client logs; outbox drains in one pass after an offline week.

**What survives the withdrawal:**
- The client's batch size (40) and request timeout (90 s) were tuned for the Fly hub's `projection_busy` (`CloudSync.ts:70-78`). With the Supabase function they may be too conservative. Measure push latency against production before changing either.
- Whether a Supabase push still costs O(change) depends on the `cmem-sync` function, which lives in the claude-mem-pro repo, not here. Review it there.
- `docs/public/cloud-sync.mdx` still says the hub's source is `services/sync-api/`. It should name the Supabase function.

### Phase 2: One registry for derived data *(design written 2026-11-28; to propose upstream, not built here)*

Design: `plans/2026-11-28-derived-data-registry.md`, written against upstream v17.0.2. In short, only the Chroma embeddings index can fall behind, and its progress lives in a JSON file that has needed its own backoff, coalescing and retry fixes. The design moves that progress into SQLite tables with a version per index, so a format change rebuilds by bumping a number. It adds a small `DerivedIndex` interface only once a second deferred index exists. FTS5, `observation_files` and the context cache stay as they are.

It isn't built in this fork because the code it rewrites (about 2,900 lines of `ChromaSync.ts`) changes upstream almost daily; a fork-only rewrite would conflict with every update (owner decision, 2026-11-28).

### Phase 3: Memory blame and path history *(done 2026-11-25; most of it already existed)*

Most of this was already built when the plan was written; Gap D overstated it:
- `observation_files` already indexes one row per path an observation reads or modifies (written via `src/services/sqlite/observations/files.ts`, read by `getObservationsByFilePath` in `observations/get.ts`).
- `/api/search/by-file` and the `files` filter on `/api/search` already return a path's memories newest first, including filter-only searches with no query.
- The File Read Gate already shows a file's memory timeline automatically when Claude Code reads a supported code file that has history (`docs/public/file-read-gate.mdx`).

What was missing, and is fixed in this PR:
- The MCP `search` tool passed `files` through but never declared it, so agents had no way to know about it. It is now in the schema and description, with a test.
- In server runtime, `search` sent `files` to the server, which ignored it and returned unfiltered results. It is now refused with the same "unsupported local filters" error as `project` and `obs_type`, with a test that fails without the fix.
- `docs/public/usage/search-tools.mdx` documents `files` and adds a "Before Changing a File" workflow.

Not done, and worth a separate look: the `files` filter matches substrings (`LIKE %path%`), so `index.ts` matches every `index.ts`. The `observation_files` index supports exact matching; switching the `search` filter to it would be more precise and faster on large databases.

### Phase 4: A thin client for ephemeral agents *(already exists; nothing to build)*

The open-source plugin already has this as the **server runtime**:
- `npx claude-mem install --runtime server --server-url <url>` (or the interactive "Server (beta)" choice) sets `CLAUDE_MEM_RUNTIME=server` (`src/npx-cli/commands/install.ts`).
- Hooks send session starts, observations and summaries to the server (`src/services/hooks/runtime-selector.ts`, `src/cli/handlers/session-init.ts`), and the MCP tools query it. The MCP server never auto-starts a local worker in this mode (`src/servers/mcp-server.ts`).
- The server is self-hostable from this repo (`src/server`, the Docker stack in `docker-compose.yml`) with API keys per team and project (`docs/public/hosted-server.mdx`). That meets decision §5.1: open source, any compatible server, URL and key as settings.

One difference from what this phase asked for: when the server is unreachable, times out, or answers 5xx/429, hooks **fall back to the local worker** (`ServerClientError.isFallbackEligible` in `src/services/hooks/server-client.ts`) instead of skipping context. On a laptop that avoids losing memory. In a short-lived sandbox it means a server outage starts a full local worker. If that matters for your sandboxes, the change is a setting to turn the fallback off. That's an upstream design choice, so raise it there rather than in the fork.

### Phase 5: Watchers *(built 2026-11-28 as an upstream drift watcher)*

The first draft had watchers for the sync hub, the observer queue and install health. The sync hub and cmem.ai belong to the upstream project, and their health data isn't available to this repo's owner, so that version would have watched nothing actionable. The owner chose an **upstream drift watcher** instead:
- `scripts/watchers/upstream-drift.sh` reports how far this fork's `main` is behind `thedotmack/claude-mem` `main`: commits, versions, releases not yet taken, and files changed on both sides (likely merge conflicts). It's read-only.
- A daily scheduled Claude task runs it and keeps one open GitHub issue on this repo labelled `watcher` + `watcher:upstream`, assigned to the owner, for Sid to read. It updates that issue as upstream moves and closes it once `main` catches up.
- **Blocked until Issues are enabled on this fork.** GitHub turns Issues off for forks by default, and the first report on 2026-11-28 was refused with `410 Issues has been disabled in this repository`. Turn it on in the repo's Settings → General → Features → Issues.

First run (2026-11-28): fork `main` v15.7.0 is **1,264 commits and 46 releases behind** upstream v17.0.2. No file has changed on both sides, so updating `main` should merge cleanly.

---

## 4. Things we deliberately won't copy

- **Not a new storage engine.** Scion replaced git because of 100 GB histories. A user's memory log is small. We are adopting the *shape* (log + derived data + thin clients), not a rewrite.
- **No Spanner or global-consensus layer.** Per-user logs on Postgres with an advisory lock are the right size for this. Keep refs and global state out of the write path, as we already do.
- **No adversarial over-hardening.** The write-up warns that adversarial review "can also be myopic." Phase 1 should trust the hub's own durability guarantee instead of layering validation on top of it.
- **No Cloudflare compute.** All new server-side work stays on Fly/Vercel, per `CLAUDE.md`.

## 5. Owner decisions (2026-11-18)

1. **Thin client ships in the open-source plugin.** `CLAUDE_MEM_MODE=remote` is a normal install mode, not a Pro-only feature. It must work against any compatible server, both self-hosted `src/server` and the hosted one, so the server URL and auth are settings rather than hard-coded cmem.ai values. Pro adds the hosted endpoint only.
2. **Background projection runs inside the existing `cmem-sync-api` Fly app.** *(Moot since Phase 1 was withdrawn: production projection happens inside the Supabase push transaction. Kept for the record.)* No new machine or process group. Phase 1 kicks projection through the in-process `user-queue.ts` and keeps the existing Postgres lease, so a second machine of the same app can't project the same user at the same time. If projection load later starts to affect push latency, the fallback is a separate Fly process group in the same app, not a new app.
3. **Watchers report to Sid through GitHub issues.** Sid is the lead bot for the agents in the UP Command Center artifact and has no GitHub account, so the issues live on this repo under the owner's account:
   - Each watcher opens or updates one issue per component, labelled `watcher` plus a component label (today only `watcher:upstream`; see Phase 5), and assigned to the repo owner.
   - It comments on the component's existing open issue instead of opening duplicates, and closes the issue when the signal clears.
   - Sid reads open `watcher` issues as its input. A later step adds a "Watcher issues" panel to the UP Command Center that lists them, so the owner sees the same queue Sid works from. GitHub stays the single record.
   - No Slack channel and no email for now.

## 6. What changed on 2026-11-28

- **This repo is a fork.** `package.json` points at `thedotmack/claude-mem` (Alex Newman). The sync hub, cmem.ai and the hosted server's production deployment belong to that project. That's why Phase 5 now watches upstream drift instead of upstream's infrastructure.
- **The fork is far behind.** `main` is v15.7.0 and upstream is v17.0.2 (1,264 commits, 46 releases). Most of this plan was researched on v15.7.0 code. Phase 2's design was redone against v17.0.2.
- **PR #1 conflicts with upstream.** A trial merge of this branch onto upstream `main` conflicts in `src/servers/mcp-server.ts` and `tests/servers/mcp-tool-schemas.test.ts`: upstream added a `deep` search option and new tests in the same places. Upstream still doesn't expose `files` on `search`, so Phase 3's change is still useful. It needs resolving once `main` is updated, and it is a good candidate to send upstream as its own PR.

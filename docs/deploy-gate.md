# Deploy gate

The deploy script proves that every new build can actually write to the collections database
before it swaps the build into the service. A build with a broken write path is never deployed:
the gate fails, no swap happens, and the previous build keeps serving.

## Where it runs

The gate is part of the server-side deploy script `/var/lib/openbot/bin/stichpunkt-deploy.sh`.
That script lives on the host, not in this repository. A cron timer runs it every five minutes as
the `openbot` user, and `flock` on `/var/lib/stichpunkt/deploy.lock` serializes concurrent runs. A
run deploys `origin/main` only when its SHA differs from `/var/lib/stichpunkt/deployed.sha` and its
CI checks are green.

## What the gate checks

Before the swap, the script builds the new commit in a throwaway worktree and starts it as a
candidate on port 8096 (`GATE_PORT`). The candidate runs against a throwaway copy of the production
database (`sqlite3 .backup` into `/var/tmp/stichpunkt-gate/collections.sqlite`), so the gate never
writes to live data and a migration of an unproven build cannot reach the production database.

Against the candidate the gate runs four API steps in order and logs each one with its status code:

| Step | Request | Expected |
| ---- | ------- | -------- |
| 1/4 | `GET /api/v1/databases`, then `GET /api/v1/databases/<id>` for one collection (the smallest by row count, or `GATE_COLLECTION`) | `200`, `200` |
| 2/4 | `POST /api/v1/databases/<id>/rows` creates a scratch row | `201` |
| 3/4 | `PATCH` the same row with a stale `base_updated_at` (1970) | `409` |
| 4/4 | `DELETE` the scratch row | `200` |

Every gate write carries the actor `deploy-gate` and the header
`X-Note: deploy gate #81 (scratch row, deleted automatically)`, so it is recognizable in the
revision history. A run that crashes between step 2/4 and 4/4 leaves its scratch row id in
`/var/tmp/stichpunkt-gate/row`, and the next run deletes that leftover row first.

## Failure modes

- **Candidate does not start** (infrastructure, for example a busy port or a failed database copy):
  the log records `gate: candidate not ready for <sha> — kein Swap, <deployed> läuft weiter`. No
  swap, no `deploy.failed` marker, the next timer tick retries.
- **The build fails the gate** (any step returns an unexpected code): the log records
  `gate failed for <sha> — kein Swap, <deployed> läuft weiter` and the SHA is written to
  `/var/lib/stichpunkt/deploy.failed`, so a broken build is not retried every five minutes. No swap.
- **The swap succeeds but `/healthz` fails afterwards**: the script restores the previous build from
  `/var/lib/stichpunkt/build-prev`, restarts the service and marks the SHA as failed.

In all three cases the previously deployed build keeps serving.

## Modes

| Invocation | Effect |
| ---------- | ------ |
| (no arguments) | normal timed deploy of `origin/main` |
| `--force` | deploy the current `origin/main` even when its SHA is already recorded |
| `--gate URL` | run only the write gate against an already running instance at URL |
| `--gate-test [SHA]` | build SHA (default `origin/main`) in a throwaway worktree, gate that build, stop again; never swaps or restarts anything |
| `--cleanup` | prune stale worktrees, temp dirs and merged local branches |

## Proving the refusal

The test hook `GATE_DB_READONLY=1` makes the candidate's database copy and gate directory
read-only, which simulates a broken write path:

```bash
GATE_DB_READONLY=1 /var/lib/openbot/bin/stichpunkt-deploy.sh --force   # exits 1, no swap
```

The hook leaves `/var/tmp/stichpunkt-gate` read-only. Clean it up right after the test, or the next
deploys fail with `gate: candidate not ready`:

```bash
chmod -R u+rwX /var/tmp/stichpunkt-gate && rm -rf /var/tmp/stichpunkt-gate
```

## Evidence

`docs/assets/deploy-gate-evidence.png` shows the four gate steps of a real deploy, a `--gate-test`
pass on the current HEAD, a refusal run with `deployed.sha` unchanged, and read-only queries that
prove the scratch rows never persist while the audit entry keeps the actor `deploy-gate`. Measured
2026-11-15 against build `943bab4`. Acceptance: issue #81.

## Operational notes

- The script is unversioned. A stale copy without the gate exists at
  `/var/lib/openbot/OpenBot/Shared/stichpunkt-deploy.sh`; cron does not reference it. Edit
  `/var/lib/openbot/bin/stichpunkt-deploy.sh` when the gate changes, and keep this document in sync.
- Gate state directory: `/var/tmp/stichpunkt-gate`. Gate worktree:
  `/var/lib/stichpunkt/gate-worktree`. Log: `/var/lib/stichpunkt/deploy.log`.

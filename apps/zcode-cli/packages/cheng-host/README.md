# @zcode/cheng-host

P2 resident service for Cheng capabilities. It wraps the pinned CSG v2 runner
and projects its evidence through `@zcode/cheng-contract`. P2 is
**diagnostic-only**: a healthy chain returns `rc=41` / `DIAGNOSTIC_NOT_ACCEPTANCE`
and is never reported as production acceptance.

Decisions frozen on 2026-11-06 (plan §8.4):

1. Runtime is a fixed cheng-lang git checkout addressed by `ZCODE_CHENG_ROOT`;
   missing/non-git/missing-runner/missing-driver fails startup with exit `78`.
   A launcher may pass `--expect-head-sha` / `--expect-runner-sha` /
   `--expect-driver-sha`; a mismatch is the same startup failure.
2. `verify` is a read-only projection of the on-disk run volume; it writes
   nothing, so there is no per-run verify lock.
3. Artifact root is `<dataBaseDir>/.chengcode/v2/cheng/<wsHash32>/`; its real
   path must be outside the workspace, otherwise startup fails.
4. Same-key jobs dedup only while `queued`/`running`; a terminal job replays
   its terminal state. Rerunning a cancelled/failed job requires an `attempt`
   nonce.
5. Workspace scope = detached host + Unix socket + token. Session scope =
   stdio child with an allowlisted environment; it exits with the parent and
   cancels its jobs.

## Frozen operation surface

| op | shape | P2 |
|---|---|---|
| `capabilities` | sync | implemented |
| `spec.validate` | sync, paths under `ZCODE_CHENG_ROOT` (or `--spec-root`) | implemented |
| `generate` | async job, `mode="diagnostic"` | implemented |
| `job.status` / `job.cancel` | sync | implemented |
| `verify` | sync read-only projection (`RunVolumeReceipt` + settle + structure) | implemented |
| `settle` | sync, trace projection | implemented |
| `graph.query` | sync, bounded summary + artifact ref + digest | implemented |
| `parse` / `typecheck` | advertised `false`, `host.opUnavailable` | not implemented |
| `plan` / `decide` / `graph.diff` | advertised `false` | not implemented |

`capabilities` carries `PROTOCOL_VERSION`, `CONTRACT_MAJOR`, the runtime pins
(`headSha`, runner/driver sha256) and a `fingerprint` over the whole table.
Clients must call it before any other method; a mismatch is refused, not
downgraded.

## Protocol

Newline-delimited JSON over stdio (session scope) or a Unix socket (workspace
scope). Frames: `hello`, `req`, `res`, `evt`; 1 MiB inbound cap, 16 KiB event
cap. `hello` carries the workspace root (realpath-compared) and, for sockets,
the host token. Outbound results are re-validated against their zod schema;
oversized results are refused rather than truncated. Job events are
`job.progress` (2 s heartbeat) and `job.state` (terminal exactly once);
`job.status` remains the authority after a reconnect.

## Artifacts and lifecycle

```
<dataBaseDir>/.chengcode/v2/cheng/<wsHash32>/
  host.json / host.token / host.sock / host.spawn.lock   (workspace scope)
  jobs/<jobId>/
    job.json        state journal, atomic rename
    events.jsonl    progress/state events
    runner.*.log
    out/runs/<runId>/{run.env,report.txt,judge,...}
```

`jobId = sha256(canonical{specSha,task,mode,budget,headSha})`; with an
`attempt` nonce the nonce is part of the hash. `job.json` records
`pid/pgid/procStart`; cancel and restart recovery signal the process group only
when `ps` still reports the same start stamp. When the identity cannot be
confirmed the process group is left untouched and the job still fails closed
(`host.hostRestarted` / `host.processTreeLeaked`); it is never mis-killed.

On restart, `queued`/`running` jobs become `failed(host.hostRestarted)` — never
a fabricated PASS. Session-scope hosts write to their own
`sessions/<pid>-<nonce>` subtree so recovery cannot touch another live host's
jobs.

## Not in P2

Super-agent S0/S1 wiring (registry persistence, `runs.list`, refeed, egress,
write leases), P3 tools/facade, P4 planner/`ChengPlan`/`ChengGate`, production
driver provenance and Windows are out of scope. `structure` is `null` for
single-module runs because `modules.tsv` does not exist; it is never invented.

## Commands

```sh
pnpm --dir apps/zcode-cli/packages/cheng-host typecheck
pnpm --dir apps/zcode-cli/packages/cheng-host lint
pnpm --dir apps/zcode-cli/packages/cheng-host test          # 48 unit tests
pnpm --dir apps/zcode-cli/packages/cheng-host build
```

Real runtime gate (p02 parity, cancel, workspace restart):

```sh
CHENG_HOST_REAL=1 CHENG_HOST_REAL_ROOT=/Users/mac/cheng-lang \
  npx vitest run tests/integration.real.test.ts
```

Parity compares `judge.tsv`, `judge_inputs.tsv` and the replay `trace.jsonl`
byte-for-byte, and every `prog_receipts.tsv` field except `report_sha256`
(that hash covers a compile report which embeds the absolute `--out` path).

2026-11-06 evidence: unit `48/48`; real gate `2/2` (p02 `rc=41` /
`DIAGNOSTIC_NOT_ACCEPTANCE`, cancel, and a workspace host killed with SIGKILL
restarts with the in-flight job `failed(hostRestarted)` and its process group
reaped).

The host imports `@zcode/cheng-contract` through the workspace. Until the
lockfile importer lands (blocked by another lane's pending lock changes), a
local dev link is required:

```sh
ln -sfn ../../apps/zcode-cli/packages/cheng-contract node_modules/@zcode/cheng-contract
```

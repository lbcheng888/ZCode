# @zcode/cheng-contract

Typed, fail-closed projections of Cheng pipeline run volumes for ZCode.

This package is the L0 contract layer described in
`cheng-lang/docs/cheng-zcode-superagent-plan.md`. P1 covers thirteen artifacts:

| Artifact | Source | Schema |
|---|---|---|
| `ChengSpecRef` | spec v2 task + optional index | `cheng.contract.cheng_spec_ref.v1` |
| `JudgeVerdict` | `<run>/judge/judge.tsv` | `cheng.contract.judge_verdict.v1` |
| `JudgeInputsReceipt` | `<run>/judge_inputs.tsv` | `cheng.contract.judge_inputs.v1` |
| `ProgReceipt` | `<run>/prog_receipts.tsv` | `cheng.contract.prog_receipt.v1` |
| `ModuleLedger` | `<run>/evidence/modules.tsv` or `<run>/modules.tsv` | `cheng.contract.module_ledger.v1` |
| `SettleReceipt` | `<run>/tasks/<task>/replay.run1/trace.jsonl` | `cheng.contract.settle_receipt.v1` |
| `StructureReceipt` | spec `links[type=composes]` + `modules.tsv` | `cheng.contract.structure_receipt.v1` |
| `RuntimeManifest` | `<run>/run.env` + optional `<run>/hashes.tsv` | `cheng.contract.runtime_manifest.v1` |
| `ChengError` | CSG v2 runner exit code + evidence | `cheng.contract.cheng_error.v1` |
| `DecisionFrame` | `data/decision_traj` v0 decisions/precedents | `cheng.contract.decision_frame.v1` |
| `DerivationGraph` | `trace.jsonl` decision graph | `cheng.contract.derivation_graph.v1` |
| `ChengPlan` | deterministic planner plan JSON | `cheng.contract.cheng_plan.v1` |
| `RunVolumeReceipt` | aggregate of the run artifacts + acceptance | `cheng.contract.run_volume.v1` |

## Usage

```ts
import {
  classifyRunnerExit,
  parseChengPlanJson,
  readChengSpecRef,
  readDecisionFrames,
  readDerivationGraph,
  readRunVolume,
  readSettleReceipt,
  readStructureReceipt,
  readRuntimeManifest,
} from "@zcode/cheng-contract";

const spec = readChengSpecRef("/path/to/spec.json", "/path/to/index.json");
// spec.modules.length, spec.links, spec.indexSha256

const receipt = readRunVolume("/path/to/run-volume");
// receipt.judge[0].status === "semantic_pass"
// receipt.progReceipts[0].judge === "semantic_pass"
// receipt.acceptance.level === "DIAGNOSTIC_NOT_ACCEPTANCE"
// receipt.checks.judgeRowsDeclared === true

const settle = readSettleReceipt("/path/to/trace.jsonl");
// settle.settles.some(s => s.kind === "fn" && s.verdict === "pass")
// settle.settles.some(s => s.kind === "program" && s.verdict === "pass")

const structure = readStructureReceipt("/path/to/spec.json", "/path/to/modules.tsv");
// structure.checks.specComposesCount === 4
// structure.checks.ledgerCallEdgesSum === 1
// structure.checks.structureGateOk === false

const manifest = readRuntimeManifest("/path/to/run-volume");
// manifest.checks.manifestComplete === true

const frames = readDecisionFrames("/path/to/decisions.jsonl");
const graph = readDerivationGraph("/path/to/trace.jsonl");
const plan = parseChengPlanJson(planText);
const error = classifyRunnerExit(31, ["gap.txt: exhausted"]);
```

Low-level parsers (`parseChengSpecRef`, `parseJudgeVerdictTsv`,
`parseJudgeInputsTsv`, `parseProgReceiptTsv`, `parseModuleLedgerTsv`,
`parseSettleReceiptJsonl`, `parseSpecComposes`, `parseRunEnv`, `parseHashesTsv`,
`parseDecisionFrameJsonl`, `parseDerivationGraphJsonl`, `parseChengPlanJson`)
take text plus a source path and are pure. `classifyRunnerExit` maps the CSG v2
runner table; unknown codes throw instead of guessing.

## Acceptance

`RunVolumeReceipt.acceptance` is run-level, not judge-level:

- `mode`: `production` | `diagnostic` | `unknown` from `run.env`/`report.txt`.
- `level`: `PRODUCTION` | `DIAGNOSTIC_NOT_ACCEPTANCE` | `UNKNOWN`.
- `productionAcceptance`: `true` | `false` | `null` from `report.txt`.
- `verdict`: the report verdict (`PASS`, `DIAGNOSTIC_NOT_ACCEPTANCE`, …).

A diagnostic run can be `semantic_pass`; only `level=PRODUCTION` may be consumed
as production. A `PRODUCTION` claim requires every run check to pass.

## Fail-closed rules

Every failure is a typed `ChengContractError`; no partial result and no default
value is returned.

- `CHENG_CONTRACT_MISSING_FILE`: required artifact is absent.
- `CHENG_CONTRACT_IO_ERROR`: the file exists but cannot be read.
- `CHENG_CONTRACT_INVALID_TSV`: BOM, empty file, blank line, header drift,
  wrong column count, non-integer or negative count.
- `CHENG_CONTRACT_SCHEMA_INVALID`: enum/format/count/invariant failure, including
  `semantic_pass` without `compile_rc=run_rc=rc=0`, full eval/props, and a
  non-`-` program sha; `judge=semantic_pass` without `status=judged`;
  `fn_verdict=pass` with a short count; duplicate task/module/tier keys;
  judge/prog task-set mismatch; judge/prog program-sha mismatch; judge rows that
  disagree with `judge_inputs.declared_rows`; a `PRODUCTION` claim whose mode
  is not `production`; a settle phase whose `settle_index` is not strictly
  increasing, whose `(kind,fn)` repeats, whose `pass` counts are inconsistent,
  or whose `trace_done.final_*` disagrees with the program settle; a spec
  composes endpoint that is not a module, a duplicate composes edge, or a
  spec/ledger module join or role mismatch; a `RuntimeManifest` whose run.env
  pin is missing or malformed, whose hashes.tsv lacks head/driver/judge/
  spec_index, or whose hashes disagree with run.env; a `ChengSpecRef` whose
  index entry sha disagrees with the spec, whose module/link ids repeat, or whose
  composes endpoint is not a module; a `DecisionFrame` with a missing/extra v0
  field, `legal` not boolean, `context_cid` not 64-hex, `chosen` outside
  `candidates`, an unknown `judge_verdict`, or a duplicate `hole_id`; a
  `DerivationGraph` whose `parent` is not the hole creator, whose roots/created
  ids repeat or conflict, whose `call_edges` reference unknown fn/frame, or whose
  trace envelope is missing; a `ChengPlan` with no candidates, empty evidence,
  negative cost, out-of-range `expectedGain`, a `recommended` pair outside
  candidates, a duplicate `(action,target)` pair, or `stop` mixed with other
  actions.

`ChengError` classifies only the CSG v2 runner table. `0` returns `null` (PASS);
an unknown code (including v1 modgen and signal codes) throws
`CHENG_CONTRACT_UNKNOWN_EXIT_CODE`; empty evidence throws
`CHENG_CONTRACT_MISSING_EVIDENCE`. There is no fallback class.

`modules.tsv` is optional: p02/p16 are single-module runs and do not produce it.
The dag3 fixture is the five-module ledger used by the contract tests. A trace
with no settle events (`invalid_path`) has no `SettleReceipt` and fails closed.
`StructureReceipt` is count-based because `modules.tsv` exposes only per-module
`call_edges`: each composes caller needs `call_edges >=` its composes out-degree.
`(caller,callee)` pair identity still requires trace `decision.call_edges`.
`RuntimeManifest` treats `hashes.tsv` as optional: without it the manifest is
valid but `manifestComplete=false` because judge/spec-index pins are absent.

## Not in this contract layer

The resident `cheng-host`, workflow facade/tools, `ChengGate`/planner execution,
and super-agent S0–S4 wiring are not part of this contract package. The pipeline
still emits TSV/JSONL rather than native `cheng.contract.*` JSON; the contracts
are read-only projections, not the producer-side schema migration.

## Commands

```sh
pnpm --dir apps/zcode-cli/packages/cheng-contract typecheck
pnpm --dir apps/zcode-cli/packages/cheng-contract test
pnpm --dir apps/zcode-cli/packages/cheng-contract lint
pnpm --dir apps/zcode-cli/packages/cheng-contract build
```

The optional real-volume test reads the original `cheng-lang` volumes:

```sh
CHENG_REAL_RUN_ROOT=/Users/mac/cheng-lang \
  pnpm --dir apps/zcode-cli/packages/cheng-contract test
```

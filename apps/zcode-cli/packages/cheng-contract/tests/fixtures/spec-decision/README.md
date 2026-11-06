# spec-decision fixtures

Byte-for-byte copies of real `cheng-lang` artifacts used by
`ChengSpecRef` (`cheng-spec-ref.ts`) and `DecisionFrame`
(`decision-frame.ts`). The contract tests do not depend on a local
`cheng-lang` checkout.

## Spec v2 (canonical)

Source tree: `cheng-lang/data/spec_v2/`

| Fixture | Source | SHA-256 |
|---|---|---|
| `spec_v2/index.json` | `data/spec_v2/index.json` | `6936717412a74351c21aab8f22692e9cacff5d2d84426ecca725cc1286b3c9ae` |
| `spec_v2/schema.v2.json` | `data/spec_v2/schema.v2.json` | `9db062660842c6b9afd2680b88f36a1ae0e926450aed9ea03e328c906be19d39` |
| `spec_v2/tasks/p02_min2.spec.json` | `data/spec_v2/tasks/p02_min2.spec.json` | `4cb7980f4736b98fe79acd3c1c2a806e14a70fdebb78d7e5dd35826ad71271f3` |

`spec_v2/index.json` lists 19 canonical tasks; `p02_min2` is entry
`task_index=1` and its index `sha256` equals the spec file SHA-256 above.
The spec file has 1 entry module and 5 links of types
`implemented_by`/`verified_by`/`exercises`; three of them point at
`req.`/`ast.` ids rather than modules.

## Spec v2 dag3 (non-canonical caller fixture)

Source tree: `cheng-lang/data/spec_v2_dag3/`

| Fixture | Source | SHA-256 |
|---|---|---|
| `spec_v2_dag3/index.json` | `data/spec_v2_dag3/index.json` | `fc41357545f290e7bbae05bdc75493ba60915a38baec2052173cee353ec2b8ed` |
| `spec_v2_dag3/tasks/c01_dag3_par.spec.json` | `data/spec_v2_dag3/tasks/c01_dag3_par.spec.json` | `6a210eb3120a6bafec58c3b15a2a99ee8347ddeaa620ee25195c0a88360ab7ab` |

`c01_dag3_par` has `task_index=201`, 5 modules, and 4 `composes` links,
including helper→helper `via_inc→inc` and `via_dbl→dbl`. It exists to prove
the parser does not assume entry→helper-only composes edges.

## Decision data v0

Source tree: `cheng-lang/data/decision_traj/`

| Fixture | Source | SHA-256 |
|---|---|---|
| `decision_traj/schema.decision_data.v0.json` | `data/decision_traj/schema.decision_data.v0.json` | `c3096422bf0e4da182ee413ea46ce27b43a252970cac81527bffd57620ebb546` |
| `decision_traj/v0/decisions.sample.jsonl` | `data/decision_traj/v0/decisions.jsonl` lines 1-2 | `445e3667dc9c6c46c78c3cf957649c2c50b59833b1809fcb055ddafb95791e76` |
| `decision_traj/precedents/precedents.sample.jsonl` | `data/decision_traj/precedents/precedents.jsonl` lines 1-2 | `ca5d65f0db94863c35e38ab6f6c524f77530b5a02f2c8994229f517bcbb2d626` |

Source-file SHA-256 (for subset provenance):
`data/decision_traj/v0/decisions.jsonl` =
`e6c58a54274e90503b12d06659213d541c203a0e27d069a066c5e802793c5d6c`,
`data/decision_traj/precedents/precedents.jsonl` =
`9b6f672545b9e0effd85f5e67108d3226a66382ab61b456159a81a7daa7dc168`.

The two sample files keep the first two records of each real JSONL, unchanged.
M5 decision records use `schema=csg.decision_data/v0`; the real precedent
records use `schema=csg.decision_data/v0.precedent` plus a `hole_ctx` object
(see `_precedent_extension` in the schema file). `DecisionFrame` accepts the
`.precedent` spelling only for the precedent hole form and keeps `hole_ctx`
optional, as instructed ("precedent 形可有 hole_ctx").

The v0 schema declares `provenance.source` + `provenance.sha256_or_commit` as
required, but the real corpus splits by form: 0/389 M5 frames carry either
field (they carry `source_trace` + `source_sha256` instead, 389/389), while
50/50 precedents carry `source` + `sha256_or_commit` and no `source_trace`.
`DecisionFrame` therefore requires `source`/`sha256_or_commit` for precedent
frames, and for M5 frames accepts either the real corpus pair
(`source_trace` + `source_sha256`) or the schema pair, rejecting frames with
neither instead of fabricating absent fields.

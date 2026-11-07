# Cheng contract fixtures

These files are byte-for-byte copies of real pipeline artifacts. They are
committed so the contract tests do not depend on a local `cheng-lang` checkout.

## p02_min2 (diagnostic)

Source: `.c0run/codegen-serial/diagnostic/p02_min2/attempt2/runs/m5-20261104T230710Z-83815`

| Fixture | SHA-256 |
|---|---|
| `run-p02/judge/judge.tsv` | `7fd1c090d219634d06e4e906f242d5e12685f62463279433fc2b163bbbeeafff` |
| `run-p02/prog_receipts.tsv` | `02d4871476dc95e1657d7b3c8e3b9c5ebf5972728155bdf126d0a1069ba81029` |
| `run-p02/judge_inputs.tsv` | `443ee1cad16f34fed2137e5743359fafccdd769fc1cad2197ba74ba2d0b5c17a` |
| `run-p02/report.txt` | `19f509bdb24a173a982ad2c826c2510c0b146a0e8a7ab98b5b7fe529f23bbb6a` |
| `run-p02/run.env` | `044f7727ba813bfb77c81b6f0779d64f9b31e30e662ddfc801eeb771b6422d67` |
| `run-p02/trace.jsonl` | `25d12b56eab6e332bee8a2afd86215059fceaafb29e1147b985130b496be6933` |

The trace is a real p02_min2 replay trace from
`.c0run/csg_integration_r1/evidence/per_task/p02_min2/trace.jsonl`; the original
attempt2 run directory was removed after the judge/prog fixtures were copied.

## p16_glue_len (diagnostic)

Source: `.c0run/codegen-serial/diagnostic/p16_glue_len/attempt2/runs/m5-20261104T230212Z-77664`

| Fixture | SHA-256 |
|---|---|
| `run-p16/judge/judge.tsv` | `ca9936d36c7ea5d0ccbca6be8a3bc1b3648c8567622195f28e8edc9a404b5e03` |
| `run-p16/prog_receipts.tsv` | `05d9364806ce35d0c06522c0da6c82f51da8a6de9af1a9764fe67685c665033e` |
| `run-p16/judge_inputs.tsv` | `ac8223d3abfe2e8e4949cfce9d31f289ddb3155e54a2bd3cbba82ff6e1f3c186` |
| `run-p16/report.txt` | `e1c9868cb90120661c5ce7e13c2822ad7bb3ff1bc7b778c8ce6741d41966cd83` |
| `run-p16/run.env` | `0e0517a24b7c38ef621574bf1c9d31f4d092e29755a296542d9b06d4d36f90e8` |
| `run-p16/trace.jsonl` | `4d1a9467adada9acbdbdf6d4223add9be13f52a709783df4d7515df023841cef` |

The trace is a real p16_glue_len replay trace from
`.c0run/csg_integration_r1/evidence/per_task/p16_glue_len/trace.jsonl`.

The loose `p16.judge.tsv` / `p16.prog_receipts.tsv` copies are the parse-only
fixtures kept from P1; `run-p16/` is the complete run volume.

## p01_max2 (production)

Source: `.c0run/csg-m5-gate/zero-c-production-m5-20261102T003843Z-53507`

| Fixture | SHA-256 |
|---|---|
| `run-p01r5b/judge/judge.tsv` | `dda0ec049b8658bf7ed50f34877ad8698de76ca98a782dfb86f493680f7298d6` |
| `run-p01r5b/prog_receipts.tsv` | `1be5dcaef14589003c34571bdc110d0acdadb5984fb7e3defa60e16017fd0c1b` |
| `run-p01r5b/judge_inputs.tsv` | `72b76b3a08ac68aa4f2b6253e8453fd4e5928b45154e164e2aa054b6186454f1` |
| `run-p01r5b/report.txt` | `bf2d835eca1a39838921ad420731a2dea3dfcccd6e849e5127370c322c0865e6` |
| `run-p01r5b/run.env` | `19bf71542b9f59a37630df6e501a33b09378184e4f37c609e59da1f4aa68a4f8` |
| `run-p01r5b/trace.jsonl` | `7baf8f206a1e7d465cf92ec0350fd9762a23ec62c0ff83ed7d32aff366533da4` |

`p01_max2` is the production `PASS` sample: `report.txt` has
`production_acceptance=1 verdict=PASS`, and `run.env` has `mode=production`.
Its trace is a real p01_max2 replay trace from
`.c0run/csg_integration_r1/evidence/prod19b/p01/trace.jsonl`.

## Spec fixtures

Source: `data/spec_v2_dag3/tasks/c01_dag3_par.spec.json` and
`data/spec_v2/tasks/{p02_min2,p16_glue_len}.spec.json`.

| Fixture | SHA-256 |
|---|---|
| `specs/c01_dag3_par.spec.json` | `6a210eb3120a6bafec58c3b15a2a99ee8347ddeaa620ee25195c0a88360ab7ab` |
| `specs/p02_min2.spec.json` | `4cb7980f4736b98fe79acd3c1c2a806e14a70fdebb78d7e5dd35826ad71271f3` |
| `specs/p16_glue_len.spec.json` | `f9bb677d6789398ba4c18fa8e938c700566ed4acb9c01994d6a62a0cd58c3e5c` |

`c01_dag3_par` has 5 modules and 4 `composes` links, including helper→helper
`via_inc→inc` and `via_dbl→dbl`. Its K=1 `modules.tsv` sums to one `call_edges`
entry (`via_inc`), so `StructureReceipt.structureGateOk` is false.

## Runtime pin fixtures

| Fixture | SHA-256 | Provenance |
|---|---|---|
| `hashes/p01_max2.hashes.tsv` | `97e6c8024c791c3ece5aacc7131948ce17277a79ccd13460f2ea119de8bfd24e` | Real `hashes.tsv` from `.c0run/c0orc_emitpool_r1/verify_core_r2/census_core0/p01_max2/runs/m5-20261103T130244Z-87101` |
| `hashes/p02.synthetic.hashes.tsv` | `778c4e079e90ddc6996b669e7d91f2a6dfa4825026ca8ed2baffe4365b963e82` | Synthetic pair for `run-p02/run.env`: head/driver/m5 pins are real p02 values; judge/spec-index pins are real p01 hashes values |

The real p01 hashes fixture does not carry `m5_bin` and belongs to a different
p01 run than `run-p01r5b/run.env`; pairing them is the cross-run mismatch test.
No matching `hashes.tsv` survived for the p02/p16/p01 run-volume fixtures, so
their manifests are complete only when an explicit matching hashes file is
provided.

## dag3 module ledger

Source: `.c0run/p3_dag3_gate/k1/evidence/modules.tsv`

| Fixture | SHA-256 |
|---|---|
| `dag3/evidence/modules.tsv` | `dc23b975d66b7fb747e429f141e8c70da86bd047eb2fba651dda37e1c6af418b` |

`p02`/`p16` are single-module diagnostic runs, so they have no `modules.tsv`.
The dag3 fixture is the K=1 ledger from the three-layer/five-module DAG gate
(`inc`/`dbl` → `via_inc`/`via_dbl` → `solve`).

The optional integration test reads the original volumes when
`CHENG_REAL_RUN_ROOT` points at the `cheng-lang` checkout.

## p06_fib (diagnostic red)

Source: diagnostic run `m5-20261106T142447Z-88420` (budget 30000). The run fails
at step `[5/9]` (M5 search exhausted), so the volume has no `run.env`/trace;
these files are the structured receipts used by the ChengGate/planner tests to
classify `rc=31`.

| Fixture | SHA-256 |
|---|---|
| `run-p06/report.txt` | `deb10ed77105e5123fef65d87329573a1400fd8879562e3b6cce6313c93eb6ec` |
| `run-p06/summary.tsv` | `5c3f4e876918c4c8a848e0b0ace303b6e7031b7b5e1c0abe74044233ccd2fd23` |
| `run-p06/FAILED` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

`report.txt` carries `verdict=FAIL metric=gap` and the M5
`status=exhausted(budget) expansions=11044292` receipt; `summary.tsv` is the
machine-readable task row. Gate/planner never parse free text for verdicts:
the test builds `ChengError` via `classifyRunnerExit(31, evidence)` and only
consumes typed fields.

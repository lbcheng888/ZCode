# DerivationGraph fixtures

These are byte-for-byte copies of real `csg.decision_trace.v1` gate traces from
`cheng-lang/src/tests/fixtures/gates/g20261026_csg_decision_native/`. They add
the multi-fn / `call_edges` / `invalidated_by` / `invalid_path` shapes that the
single-fn `run-p02`, `run-p16`, and `run-p01r5b` traces do not carry.

| Fixture | SHA-256 | Shape |
|---|---|---|
| `p17_success.trace.jsonl` | `1f71cb68443020a59b8ecc3f980ccb94edc8dac4d06d8e958b81bbf1df5dbaf7` | 2 fns, 9 decisions, one `call_edges` tuple, 3 passes |
| `p17_settle_failed.trace.jsonl` | `e5b4f8cc2ca899b5bd660e8e266ad0376d3795e77c8922644b1f521163c6714d` | 2 fns, 3 fail settles, non-empty `invalidated_by` |
| `p17_invalid_path.trace.jsonl` | `61db2f176c5519f6f26f80734864c4404d74b3182ad57e827e6deb352195f9f0` | `invalid_path`, 1 decision, no settle events |

The p02/p16/p01 traces are read directly from the sibling
`tests/fixtures/run-p02`, `run-p16`, and `run-p01r5b` directories; they are not
duplicated here.

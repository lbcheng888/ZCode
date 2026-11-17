---
name: csg-ast
description: CSG-AST 生成栈的契约与判据手册（跨版本稳定面）。凡在 cheng-lang 仓做 CSG-AST、spec 生成/演进、decision-level trace、独立 judge、库学习、UniMaker 生成源的设计、实现、评审或排障，必读。涵盖 spec v2 输入契约与旧 manifest 只读兼容、spec→plan→trace→AST→Cheng 源→core0→独立判分七段管线、tools/csg_generate.sh 纯 Cheng 默认入口与 --pipeline:semantic 迁移期别名、五条判据红线、库学习 provenance；状态只给指针，不搬题库分数。（CLI 为目标口径，现态见 §3.2）
---

# CSG-AST 生成栈契约

> 本文件只写跨版本稳定的契约与判据。计数、通过率、SLA、绿数一律回读 §6 指针，不在本文件复写；引用指针时以当日盘上的 run 卷为准。契约与现态冲突时按 §3 的两栏分开读，不得用文档补白。

## 0. 权威顺序与现态纪律

| 顺序 | 权威 | 作用 |
|---|---|---|
| 1 | `openspec/changes/core0-csg-production/proposal.md`、`design.md`、`tasks.md` | 生产化合同、唯一数据流、完成定义。`openspec/changes/core0-csg-production/proposal.md:3` 明写“本文是实现合同，不代表任何能力已经完成”。 |
| 2 | `docs/contracts/csg_generation_v1.md` | v1 冻结接口：spec 清单、回执字段、判词。语义/字段/判词改动先走 CR（`:18-19`）；红线见 `:23-40`。 |
| 3 | `data/spec_v2/schema.v2.json` + `data/spec_v2/index.json` + `data/spec_v2/gate_check.py` | spec v2 的机器可读真值与覆盖门；索引/任务顺序/sha 逐项回读（`data/spec_v2/gate_check.py:388-425`）。 |
| 4 | 回执、trace、报告 | 证据与投影。图不是判定：`spec 是真相源，图是投影，compose 是真门`（`docs/cheng-plan.md:846`；`:860` 明确“图为视图，不承载判定”）。 |

纪律：

- **1:1 只落在模块/验收层**，不落语句层；模块内部是搜索空间的多对一，由契约约束、由结算判定（`docs/cheng-plan.md:850`）。
- **level 不得互升**：`decision_level` 只给 M5/reach 的逐决策轨迹；composer 程序是 `shape_level`，不得写成 decision-level（`docs/csg_production_readiness_v2.md:107-110`、`docs/csg_production_readiness_v2.md:165-166`）。
- **读数分账**：研究管线、产品 CLI、UniMaker/应用读数不互相搬运（`docs/csg_production_readiness_v2.md:25-34`；`docs/semantic_cli_report.md:1-20`）。

## 1. 输入契约：spec v2 与旧 manifest

### 1.1 spec v2（唯一机器可读真值）

| 契约面 | 字段/载体 | 稳定判据 | 依据 |
|---|---|---|---|
| 任务身份与源 | `task`、`task_index`、`title`、`source{path,lines,sha256,quote}` | 源路径/行号/quote 必须回读源文件；quote 必须落在声明行内 | `data/spec_v2/schema.v2.json:7`；`data/spec_v2/gate_check.py:486-498` |
| 类型/接口 | `module.interface{signature,params[{name,type}],returns}`；`requirement.signature` | 形参与返回类型显式；模块 `role∈{entry,helper}`；不靠隐式推断 | `data/spec_v2/schema.v2.json:47-56`、`:62-93` |
| 定义域 | `requirement.domain` + oracle 行的域 | domain 必须非空；它是**定义域声明**，不是运行期断言；生成代码不插域检查 | `data/spec_v2/schema.v2.json:56`；`docs/contracts/csg_generation_v1.md:132-140` |
| 参考语义 | `assertion.oracle{path,sha256,tier,rows}` + `data/oracle_v2/spec_defs_v2.py` | 期望值只允许在 oracle 文件；spec 对象禁止 `expected` 字段；property 期望由独立定义求值 | `data/spec_v2/schema.v2.json:5`、`:114-123`；`data/spec_v2/gate_check.py:1116-1132`；`data/oracle_v2/spec_defs_v2.py:1-20`；`data/semantic_cli/semantic_judge.py:6-12` |
| 模块依赖 | `modules` + `links`（`implemented_by`/`verified_by`/`exercises`/`composes`） | 依赖必须显式（`composes` 只允许 entry→helper，不得隐式跨模块引用）；无孤儿模块/断言；每条需求必须有 `implemented_by` 与 `verified_by`。模块 DAG/接口先冻结是设计合同，不是当前 spec v2 门的附加断言（`docs/cheng-plan.md:854`） | `data/spec_v2/schema.v2.json:182-190`；`data/spec_v2/gate_check.py:476-560` |
| held-out | `assertion.kind∈{eval,property}` 与 `settle` 分档；oracle manifest 的 `settle/eval/ref` 三列 | eval/props 与搜索物理分家；`settle` 只做诊断，不参与 `semantic_pass` | `data/oracle_v2/manifest.tsv:1`；`data/spec_v2/gate_check.py:564-620`；`data/semantic_cli/semantic_judge.py:12-17` |
| 资源预算 | v2 schema **没有** `budget` 字段；由 CLI `--budget`、编译准入（见 cheng-models）、库 `limits` 承载 | 预算必须显式进运行卷/回执；不得把缺省值写成 spec 声明，也不得写进断言 | `data/spec_v2/schema.v2.json:7-21`（required/properties 均无 budget）；`tools/csg_generate.sh:135`；`data/shape_learn/library.json:89` |
| 标注 | `flags.template_assisted`、`template_reason`、`missing` | 固定形状辅助必须显式标注，不得隐身为“通用” | `data/spec_v2/schema.v2.json:35-44`；`docs/csg_production_readiness_v2.md:107-110` |

补充判据：

- **spec 生成不是 NL 自动抽取**：`data/spec_v2/build_specs.py:3-10` 明写题单结构由人工结构化、断言从 oracle 逐行派生、**不写任何期望值**。用 LLM 直接生成 spec 时，必须产出同样的结构+源 quote+oracle 引用，并由 `tools/csg_spec_v2_gate.sh --check` 回读；不得让模型口述期望值。
- **held-out 强度分两档**：oracle 题的 eval/props 在搜索进程外，物理分家；composer 的 held-out eval 按设计在管线内参与筛选（`eval_filter.py`），只有最终 eval+props 判分在管线外（`docs/semantic_cli_report.md:46-52`、`:306-308`）。不得把两档写成同一种“分家”。
- **spec v2 无 `stub` 字段**：旧 manifest 的 `stub` 是参考语义（`docs/contracts/csg_generation_v1.md:66-100`）；spec v2 的参考语义在 oracle 文件与独立定义里。不得把旧 stub 原文搬进 spec v2 充当断言。

### 1.2 旧 manifest 只读兼容

- v1 清单是行导向指令：`system/module/fn/requires/stub/spec/dep/driver/mono`（`docs/contracts/csg_generation_v1.md:46-64`）。每个 fn 的断言组字段是 provider/signature/requires/stub/examples（`:66-100`）。
- v1 已冻结：语义、字段名、字段含义、判词拼写不得静默改；任何改动先 CR（`docs/contracts/csg_generation_v1.md:1-19`、`:23-40`）。
- 缺省 `tools/csg_generate.sh` 已是纯 Cheng spec v2 语义管线（无题名白名单）；v1 manifest 仅经显式 `--pipeline:modgen` 只读兼容入口消费，缺省入口传 v1 manifest 直接 `die 10`（判词 `legacy v1 manifest replay is explicit`，`tools/csg_generate.sh:12-32`、`:141`、`:448-463`）。
- **只读兼容的边界**：能读、能重放、能出回执；不得为了适配新管线改写旧 manifest 的断言或期望（v1 冻结与“字段只搬运不发明”：`docs/contracts/csg_generation_v1.md:18-19`、`:23-29`）。要迁移就新增产物并记录源 sha/来源，不得覆盖历史清单。**只读兼容不等于继续占缺省生产入口**：目标 CLI 收敛后，旧 manifest 仍可读/可重放，但生产默认必须是无题名白名单的纯 Cheng 语义管线（`openspec/changes/core0-csg-production/tasks.md:16`）。
- 清单目录只接受首个非注释行以 `system ` 开头的第一层 `*.manifest`；其它清单打印 `skip` 并跳过，不静默吞错（`tools/csg_generate.sh:28-32`）。
- 新增模式时**缺省行为逐字节不变**是硬门：改动前快照与当前脚本的 `--help`、`summary.tsv`、`verdict.txt` 必须逐字节相同（`tools/csg_semantic_cli_gate.sh:8-12`、`:69-90`）。

## 2. 管线：七段与 decision-level trace

固定数据流（目标合同）：`spec → CSG-AST typed holes → Choice/Noul/Score → derivation/decision receipts → 确定性结算 → Cheng 源 → 同一 core0 → 原生运行`（`openspec/changes/core0-csg-production/design.md:11`）。逐段判据如下。

### 2.1 spec → plan

- plan 是 spec 的投影，不是真相源：需求/模块/接口/验收/链接才是 typed 数据；图、表、追溯矩阵从 spec 生成（`docs/cheng-plan.md:846-850`）。
- 1:1 只要求“一条需求 ↔ 一个模块接口/一组验收”，不得要求提示词写死每个决策（`docs/cheng-plan.md:850`）。
- 计划体必须能机检：每条需求至少一条验收、每条验收被 compose 实际执行、无孤儿模块/需求（`data/spec_v2/gate_check.py:476-560`；`docs/cheng-plan.md:856`）。

### 2.2 decision-level trace（每帧必须可结算、可重放）

| 必需面 | 稳定含义 | 现行载体/字段 | 依据 |
|---|---|---|---|
| hole | 类型化空洞的身份：语句位/表达式位、类型、深度、槽位、所属 fn/block/round | `kind`、`depth`、`slot`、`block`、`fn`、`round`；M5 的 `ETagHole`/`ndHole`。类型位在节点 `ETagHole` 的 `a=目标类型`，现行 menu 行未带 `ty`；统一 schema 需补齐 | `data/reach/out/p04_sum_to.r1.menu.jsonl:1`；`src/tools/csg_ast_m5.cheng:134`、`:1233`；`openspec/changes/core0-csg-production/tasks.md:15` |
| candidates | 物化候选清单（语法×类型×作用域合法构造物），不是 token 掩码 | `menu:[{cat,inst,score,hit}]` | `data/reach/out/p04_sum_to.r1.menu.jsonl:1`；`docs/cheng-plan.md:816-817` |
| selected | 本帧实际选中的候选 | `label_index`、`label_cat`、`label_inst` | `data/reach/out/p04_sum_to.r1.menu.jsonl:1` |
| score | 候选排序分；**只调度搜索顺序，不定义输出** | `menu[].score`；回执 `score_selfcheck` | `data/reach/out/p04_sum_to.r1.menu.jsonl:1`；`data/semantic_cli/runs/failure-p16-impossible/tasks/p16_glue_len/receipts.jsonl:2`；`docs/cheng-plan.md:810`、`:817` |
| pruned | 前沿可行性门/Noul 剪枝、类型/深度/配额剪枝 | `noul_prunes`、`type_prunes`、`round_cuts`、`own_prunes`、`quota_cuts`、`true_while_cuts`、`const_val_cuts` | `data/semantic_cli/runs/failure-p16-impossible/tasks/p16_glue_len/receipts.jsonl:2`；`docs/cheng-plan.md:817` |
| parent | 推导树父节点身份（从哪个空洞/候选展开而来） | 现行 menu 回执只有 `fn/block/depth/slot` 上下文，**没有独立 `parent_id` 字段**；统一 schema 必须显式化 | `data/reach/out/p04_sum_to.r1.menu.jsonl:1`；`openspec/changes/core0-csg-production/tasks.md:15` |
| settle | 完成子树的承诺-结算；九态 Fact；结算失败沿依赖传播失效 | `status`、`settle_passed`、`settle_final`、`settle_cases`、`oracle_sha`；九态语义 | `data/semantic_cli/runs/failure-p16-impossible/tasks/p16_glue_len/receipts.jsonl:2`；`docs/cheng-plan.md:819` |
| invalidation | 失效传播：结算失败使依赖它的上层承诺失效，未结算不可出作用域 | 设计条款；现行 M5 回执未见失效边字段（以 `data/semantic_cli/runs/failure-p16-impossible/tasks/p16_glue_len/receipts.jsonl:2` 为例），统一 schema 任务 11 才要求补齐。已实现的近似物是 provenance 层反向影响闭包 | `docs/cheng-plan.md:819`；`data/semantic_cli/runs/failure-p16-impossible/tasks/p16_glue_len/receipts.jsonl:2`；`tools/csg_impact.py:1-21`；`docs/impact_graph_report.md:1-30` |
| replay | 同一决策序列可重放为同一程序 | `PATHV1` 的 `CTX`/`STEP`/`PROGRAM`，配 `*.menu.jsonl` | `data/reach/out/p04_sum_to.r1.path:1-26` |

硬判据：

- **父节点不许猜**：没有显式 parent 字段时，不得用步序或槽位“推断”父子关系冒充 trace。统一 schema 是 `openspec/changes/core0-csg-production/tasks.md:15` 的任务 11；在此之前，评审只接受“上下文坐标+步序”，并在缺口栏写明。
- **失效传播分两层**：decision trace 级是 `docs/cheng-plan.md:819` 的合同条款，现行回执无失效边字段（以 `data/semantic_cli/runs/failure-p16-impossible/tasks/p16_glue_len/receipts.jsonl:2` 为例）；artifact 级是 `data/impact_graph` 的正/反向闭包（`tools/csg_impact.py:1-21`）。两层不得混写；impact graph 的读数不能证明 decision trace 有失效传播。
- **level 标注**：M5/reach 轨迹才是 `decision_level`；composer 只有候选形状/参数（`shape_level`），没有逐决策 trace（`docs/csg_production_readiness_v2.md:107-110`）。
- **确定性**：同一输入、同一预算、同一结算档双跑，stdout/回执/组合体逐字节一致（`docs/contracts/csg_generation_v1.md:35-38`；`tools/csg_generate.sh:49-54` 的 PASS 定义）。

### 2.3 AST → Cheng source

- 表示层是 typed holes：动作空间=语法×类型×作用域三重合法构造物；良构性由构造保证，**不生成文本，生成推导树**（`docs/cheng-plan.md:816`）。M5 的定位就是“函数级 typed-hole + Choice + 发射 + 结算”（`src/tools/csg_ast_m5.cheng:1-6`）。
- Cheng 源必须由受控发射器（或等价的合法化步骤）产出，且通过合法面门：不得出现已移除/非法写法；`tools/csg_emitter_legal_gate.sh:1-20` 检查发射器模板与重发射程序，`tools/csg_product_legal_gate.sh:1-20` 检查产品程序无非法行并逐文件回读 sha。合法面唯一权威是 `docs/cheng-formal-spec.md`（见 `.agents/skills/cheng-language/SKILL.md:10-14`）。

### 2.4 core0 编译 → 运行

- 生产闭包只允许纯 Cheng 源码、纯 Cheng 编译器、确定性内存与原生目标产物；C 编译器、cold parser/runtime、C provider、backend2、ORC/RC 均不得进入编译/链接/运行/CSG-AST/RSI 的验收闭包；cold 对照与混合链接只作过渡诊断（`openspec/changes/core0-csg-production/design.md:3-5`；`openspec/changes/core0-csg-production/proposal.md:11`）。这是目标合同：`openspec/changes/core0-csg-production/tasks.md:1-22` 当前全部未勾选，未完成项不得当已实现。
- 编译/运行必须留下真实回执：编译 rc、运行 rc、产物身份；不得用模拟、旧产物或局部对象冒充（`openspec/changes/core0-csg-production/proposal.md:14`、`:41`；`openspec/changes/core0-csg-production/design.md:11`）。
- 内存/时间/准入判据不在本技能复制：凡 768MiB、50ms、`compile_admission`、烤种/face pin、A/B 仪器，一律走 `cheng-models` 技能（`.agents/skills/cheng-models/SKILL.md:1-5`）。

### 2.5 独立判分（judge）

- judge 在管线进程之外真编真跑，读 spec v2 的 eval/property 断言路径与 sha256；期望来自 oracle 文件与 `spec_defs_v2.py` 的独立定义（`data/semantic_cli/semantic_judge.py:1-12`）。
- `semantic_pass = 编译 rc=0 ∧ 运行 rc=0 ∧ eval 全过 ∧ props 全过`；`settle` 行只做诊断核对，不参与判词（`data/semantic_cli/semantic_judge.py:12-17`）。
- 输入缺失/sha 不符/行数不符 → 退出 2（基础设施错误，不静默）；判分产出 fail 行时退出 0，由 CLI 汇总为非 0（`data/semantic_cli/semantic_judge.py:16-17`）。
- 搜索内筛选不等于独立判分：composer 的 `eval_filter.py` 只在候选生成后读 held-out，props 与最终 eval+props 仍在管线外（`docs/semantic_cli_report.md:306-308`）。

### 2.6 UniMaker 生成源（应用终验）

- UniMaker 生成源必须走 `React/TS → CSG facts → materializer → retained scene → core0 → 原生宿主` 全链；不得用 cold、占位数据、旧产物或局部对象冒充完成（`openspec/changes/core0-csg-production/design.md:15`；`openspec/changes/core0-csg-production/proposal.md:14`）。
- 生成源身份必须可回读（源→facts→scene→core0 产物），并与发布产物对齐；UniMaker 的编译/运行读数不能替代 CSG-AST 的 decision-level 证据（`openspec/changes/core0-csg-production/proposal.md:37`、`:39`）。
- 全路由/事件/媒体/持久化/宿主的验收不在本技能展开；以 `openspec/changes/core0-csg-production/tasks.md:19-21` 的任务 15-17 为准（当前未勾选，不得用局部对象/路由冒充完成）。

## 3. CLI 契约：纯 Cheng 默认入口与迁移期别名

### 3.1 目标契约（生产）

- `tools/csg_generate.sh` **缺省入口即纯 Cheng 语义管线**：无题名白名单，生产规划只由 spec 的结构能力需求驱动，生产算法不由 Python/C 持有（`openspec/changes/core0-csg-production/proposal.md:37`；`openspec/changes/core0-csg-production/design.md:25`；`openspec/changes/core0-csg-production/tasks.md:16`）。
- `--pipeline:semantic` 是**迁移期别名**：指向同一条语义管线、同一套判分、同一份回执，不是第二套生产权威。迁移完成后应删除别名，而不是保留两条路径。别名口径按本任务书的目标设定；仓内当前没有别名映射的代码证据（见 §3.2）。
- Python 只保留独立 oracle/诊断：独立判分器可以用 Python；但 Python 不得成为生成/搜索/组合算法的 owner（`openspec/changes/core0-csg-production/design.md:25`）。
- 失败必须非零退出、不发布；不得静默 fallback 到题面例集或旧管线（`openspec/changes/core0-csg-production/proposal.md:38`；`docs/contracts/csg_generation_v1.md:23-40`）。

### 3.2 现态（2026-10-31 更新：缺省语义管线已收敛）

| 面 | 目标契约 | 现态 | 依据 |
|---|---|---|---|
| 缺省入口 | 纯 Cheng 语义管线，无题名白名单 | **已达成**：缺省即 spec v2 语义管线；v1 manifest 仅 `--pipeline:modgen` 显式只读兼容（缺省传 v1 `die 10`） | `tools/csg_generate.sh:141`、`:448-463`；生产回执 `pipeline=m5-typed-hole planner=cheng task_name_routing=0` |
| `--pipeline:semantic` | 同一管线的迁移期别名 | 与缺省同路（别名） | `tools/csg_generate.sh:63` |
| 路由 | 只由 spec 结构驱动 | 生产面无题名路由；`semantic_driver.py:58-80` ROUTES 退役只读登记（`csg_spec_v2_cli_gate` ④断言生产不可达） | `tools/csg_spec_v2_cli_gate`；`3020d9c62` |
| Python 角色 | 独立 oracle/诊断 | judge/oracle=独立 Python（合规）；旧 orchestrator 已退役（`csg_semantic_cli_gate.sh` 显式 RETIRED+负例拒） | `data/semantic_cli/semantic_judge.py:1-17`；`3020d9c62` |
| 失败 | 非零退出、不发布 | 已实现：未解/判分不过/回执不合规均非 0（rc=21/23/31/32/40/42 等），目录 `FAILED` 无 `PASS` | `tools/csg_generate.sh:55-60`；`.c0run/csg_prodclose_r1/RECEIPT.md` |

结论：**缺省已是纯 Cheng 语义管线（2026-10-30 起），本节与目标两栏已合流**；评审用产品 CLI 读数，不用研究管线读数替代（`docs/csg_production_readiness_v2.md:107-110`）。

## 4. 判据红线

| # | 红线 | 通过判据 | 明确禁止 | 依据 |
|---|---|---|---|---|
| 1 | **禁题名路由** | 生产规划只由 spec 的结构能力需求驱动；默认入口无题名白名单 | 用题名/`ROUTES`/按题硬编码控制生产结果；把迁移期路由包装成“通用” | `openspec/changes/core0-csg-production/design.md:25`；`openspec/changes/core0-csg-production/proposal.md:37`；现态 ROUTES 仅 `data/semantic_cli/semantic_driver.py:58-80` |
| 2 | **禁手写答案模板** | 程序由参数化形状 + 绑定生成；手写/查表通过记 `no_candidate` | 手写答案、期望值查表、按题写死的答案形模板；固定形状辅助不标注 | `docs/three_way_decision_20261024.md:47`；`data/shape_learn/DESIGN.md:95-97`；`data/spec_v2/schema.v2.json:35-44` |
| 3 | **生成物遵守 cheng-language 合法面** | 发射文本通过语法/语义/所有权/可见性门；产品程序逐文件 sha 回读 | 非法语法、业务层 hoist、其他绕过语言规则的补丁、绕过所有权/借用规则 | `.agents/skills/cheng-language/SKILL.md:10-14`；`tools/csg_emitter_legal_gate.sh:1-20`；`tools/csg_product_legal_gate.sh:1-20` |
| 4 | **结算只由确定性定义** | 期望只在 oracle；编译 rc=0 + 运行 rc=0 + eval/props 全过；双跑逐字节一致 | 用概率/采样定义输出；用题面例集拟合代替 held-out；spec 内手填 `expected` | `docs/cheng-plan.md:810`；`data/spec_v2/schema.v2.json:5`；`data/spec_v2/gate_check.py:1116-1132`；`data/semantic_cli/semantic_judge.py:12-17`；`docs/contracts/csg_generation_v1.md:35-38`；`docs/csg_production_readiness_v2.md:72-76` |
| 5 | **失败域非零退出、不发布** | 任一红/未解/基础设施错误均非 0；部分成功不得报 PASS；候选未过完整门禁不发布 | 静默成功、fallback 到例集、用 `NOT_RUN/SKIP/HARD_RED/DIAGNOSTIC` 充当完成证据 | `tools/csg_generate.sh:55-60`、`:78-79`；`openspec/changes/core0-csg-production/proposal.md:38`、`:41`；`tools/csg_shape_learn_gate.sh:9-12` |

补充：**cold 结果不计通过**。cold 对照、混合链接、C 性能数据只能作独立诊断/参照，不进入 core0 或 CSG-AST 的验收闭包（`openspec/changes/core0-csg-production/design.md:3-5`；`openspec/changes/core0-csg-production/proposal.md:41`）。

## 5. 库学习：只吸收已结算闭包，并记录 provenance

吸收条件（缺一不吸收）：

1. **已结算**：只吸收“结算过的推导闭包抽象出的战术/库条目”，不是未结算候选或 eval 选中形状（`docs/cheng-plan.md:820`）。
2. **有合同/来源/独立证据**：可复用战术必须有合同、来源和独立证据（`openspec/changes/core0-csg-production/design.md:25`）。
3. **生成侧信息屏障**：生成进程只读 settle 投影；eval/props 只在候选生成后做验证；泄漏探针必跑；禁止手写答案（`data/shape_learn/DESIGN.md:95-97`；`docs/three_way_decision_20261024.md:47-49`）。
4. **迁移验收**：迁移任务在库冻结前预注册并哈希；冻结后由独立验证员用新参数应用同一形状，不得改形状代码；失败如实记“单任务形状，不是库学习”，不调参凑绿（`docs/three_way_decision_20261024.md:49`）。

provenance 必须落盘：

- `library.json` 记录 `schema/entry_id/entry_version/classes(source)/parameters/limits/provenance`；类目录策略明写“只收 ASCII/语言标准类，不含 task id、fn 名、期望值或按题映射”（`data/shape_learn/library.json:1-5`、`:89-104`）。
- `data/shape_learn/runs/seed/freeze.json` 钉住 `library_sha256`、`projection_sha256`、`search_sha256`、`cheng_subset_sha256`、`config_sha256` 与 `module_sha256`。吸收新条目必须重算这些 pin，不能只改库文件。
- 门槛：`tools/csg_shape_learn_gate.sh` 跑 `gate_seed.py` + transfer gate + 独立审计（候选复现、预注册、确定性、eval 泄漏读路径、写边界），退出 0 才算全过（`tools/csg_shape_learn_gate.sh:1-12`）。

边界（不得外推）：eval 只证明“生成器盲”，不是“设计者盲”，不作为泛化证据；泛化只引冻结 transfer（`data/shape_learn/DESIGN.md:28`、`:66-71`）。详细读数与限制见 `docs/shape_learn_report.md`。该刀是研究刀；库学习接入生产默认入口仍归 `openspec/changes/core0-csg-production/tasks.md:16` 的任务 12，未勾选前不得宣称已生产可用。

## 6. 现状指针（不复制数字）

| 问题 | 指针 | 读法 |
|---|---|---|
| 研究管线就绪/边界 | `docs/csg_production_readiness_v2.md` | 判词与数字源表在 `docs/csg_production_readiness_v2.md:132` 起；只引用结论与边界，不搬通过率 |
| 产品 CLI 语义模式 | `data/semantic_cli/latest` + `docs/semantic_cli_report.md` | 读 `summary.json`、`suite.tsv`、逐题 `judge.tsv`；`latest` 是可变指针，可能被后续套件改指；读前先 `readlink` 并核对 `run.env`，语义模式以报告指定的 run 卷为准，不跨卷搬运 |
| 冻结输入/回执/判词 | `docs/contracts/csg_generation_v1.md` | 字段、判词、CR 流程；改动先 CR |
| 生产化 backlog | `openspec/changes/core0-csg-production/tasks.md` | 任务 11（统一 typed-hole/decision-level schema）、12（去题名路由/纯 Cheng 默认 CLI/独立判分/库学习）是收敛门 |
| 库学习 | `docs/shape_learn_report.md` + `data/shape_learn` | 结论、限制、provenance；数字回读 `verification.json`/`freeze.json` |
| 失效/影响闭包 | `docs/impact_graph_report.md` + `data/impact_graph` | 正/反向索引、缺边清单；只作 artifact 级证据 |
| 现势轮账 | `findings.md` 的「2026-10-24 core0 四平台 + UniMaker + CSG-AST 生产化立项」节（`:1741` 起）与 2026-10-25 轮次 | 原始轮账；core0/UniMaker 编译面读数不得当 CSG-AST 读数 |
| 三选一决策 | `docs/three_way_decision_20261024.md` | 为什么做库学习、验收边界 |

## 7. 交叉引用

- **cheng-language**：`.agents/skills/cheng-language/SKILL.md`（frontmatter `name: cheng语言`）；语言语法/语义唯一权威是 `docs/cheng-formal-spec.md`。本技能不复制文法，只引用其合法面。
- **cheng-models**：`.agents/skills/cheng-models/SKILL.md`。凡烤制、门轮、内存判定、时间判定、新刀预算声明、768MiB/50ms、`compile_admission`、烤种/face pin、A/B 仪器，一律按该技能执行；本技能不另立测量口径。

## 8. 交付前自检

- [ ] spec v2 过 `tools/csg_spec_v2_gate.sh --check`：schema、源 quote、链接覆盖、无手填 `expected`、oracle sha/行数一致。
- [ ] 旧 manifest 未被改写；如需迁移，新增产物并记录源 sha，缺省路径 `--help`/`summary.tsv`/`verdict.txt` 逐字节不变。
- [ ] decision trace 契约面齐全（hole/候选/选中/分数/剪枝/父节点/结算/失效传播 + replay）；父节点无显式字段时在缺口栏写明，不推断。
- [ ] 生成源过 `tools/csg_emitter_legal_gate.sh` 与 `tools/csg_product_legal_gate.sh`；无非法行、无手写答案模板。
- [ ] 编译/运行回执真实；生产闭包无 C/cold/provider/backend2/ORC；cold 只作诊断。
- [ ] 判分在搜索进程外；eval/props 为 held-out；`settle` 只诊断；`semantic_pass` 四条件同时成立。
- [ ] 任一红/未解/基础设施错误非 0 退出；未过完整门禁的候选未发布。
- [ ] 生产路径无题名路由；迁移期 `ROUTES` 只用于复现既有证据，并已登记移除计划。
- [ ] 库学习条目有已结算闭包 + 合同/来源/独立证据 + provenance pin；迁移任务预注册且冻结后未改形状代码。
- [ ] 所有数字回读 §6 指针的当日 run 卷；本技能内不出现通过率/SLA/绿数。

---
name: cheng-models
description: 纯 Cheng 自宿主编译器的确定性内存管理模型与编译时间模型操作手册。凡在 cheng-lang 仓做烤制/门轮/内存判定/时间判定/新刀预算声明，必读。涵盖：768MiB 门与逐相贴线判定、模型项斜率表（T(k)/R(k)/X2/B1/C2/M-new）、d_live 与 rss 区分、三口径纪律、仪器权威表、全局内存准入闸 mem_slot、编译三级准入 compile_admission、内容寻址驱动缓存 driver_cache、逐相时间表、L1 209s 缺口账、判据 A/B、静窗纪律、逐刀内存预算声明模板。2026-10-25 现势：1503 同窗 A/B 口径（绿数不复写，最新以 findings.md 第45/46轮为准）、烤车口径（烤种 748113d1 / 槽 268d237c / face 基座）、同窗 A/B 仪器（ab_run.py / gate_ab.sh）、落树判例与阻塞账。
---

# 纯 Cheng 确定性内存管理模型与编译时间模型

> 门值只是标量，**模型才是诊断仪器**。本技能把两套模型写成可执行协议；权威定义以文末指针文档为准，数字冲突时以约束卡/看板最新转述为准。

## 0. 2026-10-25 更新（现势快照；逐条带证据路径）

### 0.1 编译绿口径（1503 冻结清单，obj 面）

- **口径不变**：语料 `tools/core0_corpus_1503.txt`（1503 行）；逐件 `obj`，**不链接/不运行/不比对象字节**（`findings.md:1886`、`:1879`）。
- **只认同窗 A/B**：BASE=当轮 HEAD parse 面车、CAND=补丁面车，各两烤；绿数=当轮四 chunk `ev_1503_*.summary.json` 的 `greenA`/`greenB` 逐 chunk 加总，增量=`gained_green`/`lost_green` 差集。obj 总数同以当轮 summary 的 `obj_total_A`/`obj_total_B` 加总为准，**本文不复写绝对值**。
- **跨轮不可直接相减**：历史峰值与中间读数均为旧树读数、非现势（`findings.md:1816`、`:1842`、`:1843`），中间夹并发树演化与 HEAD 推进；对账一律以当轮 A/B 卷为准。
- **结构事实（不随绿数变）**：近轮增量口=x509/tls 4 件；r45→r46 基线绿集差集仅 `src/core/tooling/seven_stage_receipt.cheng` 一件（r46 复窗 HEAD 已推进，base face parse `e1715d8a`），增量口不变。
- **数字指针**：最新以 `findings.md` 第45/46轮为准——第45轮 `findings.md:1881-1886`；第46轮读数落 `.c0run/r46/kernel/ab/ev_1503_*.summary.json`（findings 尚未立第46轮节，读数以卷为准）。

### 0.2 烤车口径（每轮固定配方）

- **canonical 烤种 = `artifacts/bootstrap/cheng.stage3.bak.748113d1`**（sha `748113d1…3850`）；脚本先验 sha，漂移即 `SEED_DRIFT rc=9`（`.c0run/r45/kernel/bake_snapshot.sh:10,14`；`.c0run/r37/bake_r37.sh` 同款）。现算：槽 `artifacts/bootstrap/cheng.stage3`=`268d237c…b4b3`、bak=`748113d1…3850`。
- **官方槽 `artifacts/bootstrap/cheng.stage3`（268d237c）不能直接 `system-link-exec`**：argv 世代只有 `front|diag|obj`（无 `system-link-exec`/self-check）。要么走 `tools/seed_argv_adapter.sh`（`<system-link-exec argv>` → `车 obj <manifest> <outdir>` + `tools/asm_pipeline/asm_merge.sh`，`VEH_PIN=268d237c`），要么用 canonical 烤种新烤。证据：`tools/seed_health_probe.sh:36-37,117-121,167-172`（argv 世代只跑身份 sha+triv obj）；`tools/seed_argv_adapter.sh:9,33,97`。
- **face 默认基座 = `.c0run/scamp/round2/lane_tm33926/face`**：先整目录 rsync 该 face（providers/package/`bin_sp.o`/`bin_hc.o`），再叠轮开窗 HEAD 快照（`--exclude '*.orig'`），再叠 `PATCH_DIR` overlay（`kernel/` + `src/core0_stage/`），最后 `gen_flat_splice.py` 拼 `flat_stage.cheng`（`.c0run/r45/kernel/bake_snapshot.sh:8-22`）。r37 旧配方用旧 face `.c0run/r32/bake_fix6/face`（`.c0run/r37/bake_r37.sh:6`）。
- **每轮 BASE=当前 HEAD parse 面车、CAND=补丁面车，各两烤**：`bake_base_a/_b` 与 `bake_cand_a/_b`，两烤同 sha 才认确定性（`.c0run/r45/kernel/`、`.c0run/r46/kernel/` 目录布局；`bake_snapshot.sh:8` 的 `SRC=…/snapshot` = 轮开窗 HEAD 快照）。

### 0.3 同窗 A/B 仪器

| 仪器 | 粒度 | 参数/口径 | 判定面 |
|---|---|---|---|
| `.c0run/r37/ab_run.py` | 逐件 obj（每件 A、B 各跑一次） | `W=10`（`:9`）；**现役驱动 `KT=180`s/件**（`.c0run/r46/kernel/run_1503_ab.sh:12`；脚本默认 `KT=120`，r37 旧驱动仍 120）；**四 chunk** 376/376/376/375（`run_1503_ab.sh:9-10`）；反缓存 env 全开（`ab_run.py:19-25`）；RSS 帽 2GiB（`:7`，**诊断用**） | 逐件 `rc/n_err/first/errors/n_obj/objs/selfhost_ok` 差 + `lost_green/gained_green/first_shift/obj_name_diffs/sha_drift`（`:80-104`） |
| `.c0run/r19/gate_ab.sh` | 全量 1503 逐件 census | `S198_WORKERS=5`；`S198_CORPUS=tools/core0_corpus_1503.txt`；BASE/CAND 双车并跑（`:11-15`）→ `tools/core0_census.py`（逐件 `VEH obj`，`:31`；卷 `collect_raw.json`，`:53`） | 逐条打印 `GAIN/LOST`，`LOST` 非空即 `RESULT FAIL`（`:24-31`）；零绿损失才 exit 0 |

选型：细看对象/首错用 `ab_run.py`；守门/换基线用 `gate_ab.sh`（先跑它挡掉绿损失）。两者都必须钉两车 sha + seed sha + 语料 sha。

### 0.4 落树硬判例

1. **0 新绿不单独落树**：只前移墙/只机械消错的批次不单独 commit（r13 判例 `findings.md:1819`；第42轮 `:1860`；第43轮 `:1875`），补丁存 `tools/core0_patches/` 与下一刀捆绑。
2. **编译面+运行面正确性批次可另立判据**：不以“新绿计数”为唯一准入。先例=第44轮 item3 迁移 5 件（`car obj` → 纯链 `asm_merge_b.sh` → 运行，obj/link/run 全 rc=0、双烤对象集 sha 恒等、负例判词重基线且语义不变）——`findings.md:1866`；harness `.c0run/r44/migrated/`（`bash harness/run_all.sh` → `R44_MIGRATED_ALL_PASS`）。
3. **对象差“纯插入”核验法**：A/B 对象不等时，逐件反汇编移除新增指令后再与 BASE 逐条比对；移除后逐条相等（仅常量随 PC 池平移）=纯插入，不是语义改动。先例=第43轮 UM 14 件全为纯插入 `ldr x0,[sp]`（`findings.md:1875`）。
4. 1503 只是编译面（不链接/不运行/不比对象字节，`findings.md:1886`）；运行面必须另跑探针/负例，不得拿 1503 绿数当运行正确性。

### 0.5 关键定谳与阻塞账

| 项 | 现态/判词 | 证据 |
|---|---|---|
| `100:3 duplicate function` | 泛型重载判据缺**拼写身份**（`int` 与 `int32` 假撞）→ **s38 已修**：`generic_duplicate` 加拼写身份、候选首行胜出、限定调用不参裸名臂、显式序列实参先核后否 | commit `b22002678`（提交记录读数 1503 316→820，`100:3` 清；现势见 §0.1）；回归面 `findings.md:1844` |
| `2358:15` | **pk7 陈宽**（`par_type=2`）：非泛型跨模块函数返回 bool 直接作按值 bool 形参；`eof_checks` 本地实参板读到 `i_type=0` 陈值，回填在 `front_resolve_imports` 之后——**不是 `Value(...)` 泛型身份**。沙箱补丁 `fd2c4700`/`08d99c07`（`pb_apply` par_kind==7 定案重核 + `width_deferred` 推 pb 延后板）：**+4 绿、l3 30/32**（未落活树） | `findings.md:1884`、`:1885`、`:1886` |
| `1:13` | 生成器**编译输入身份**：`unimaker-one-click.mjs:1784` 读改写前 `materialized.text`，而限定改写只写回 `sourcePath` → **已修**（读 `sourcePath`、去重复 import、发射路径 `cheng/unimaker_gen`）；旧 r9 `1:13` → 新主源 `2358:15` | commit `f9085312c`；`findings.md:1883` |
| `s47` 纯链驱动 | **仍阻塞**：`bake_asm_merge_b.sh` `SEED_DRIFT rc=9`，纯链驱动不可重建；本批用既有 `asm_merge_gen1_r19` | `findings.md:1868` |
| `149:12` exact_def | **仍阻塞**：6 个 exact_def 全拒 | `findings.md:1868` |
| diffexec `s148` | **仍阻塞**：缺件使 `tools/diffexec_suite.sh` rc=2 | `findings.md:1868` |
| `reloff` | **已解除**：当前车 `reloff=0 nreloc=0`，纯链 rc=0（r41 的 232 属旧车） | `findings.md:1868`；`.c0run/r44/migrated/README.md` §0 第 4 条 |

### 0.6 内存实测锚（fourfam 语义探针）

- 仪器：`.c0run/core0prod/fourfam-r40/det_proof.py`——同源两烤、逐件 `/usr/bin/time -l` 取 `maximum resident set size`（`:37`），帽 `CAP=805306368`（768MiB，`:11`），`cap_respected = maxrss ≤ CAP`（`:41`）。
- **读数不变式（不复写具体字节）**：卷 `det_proof.json` 逐件 `maxrss_a`/`maxrss_b` 即实测读数，峰值/带内区间/占门比一律由卷内值现算；**判定项=全件 `cap_respected=true`**（`maxrss ≤ CAP` 是判据，不是读数）；两烤重合度=卷内 `maxrss_a==maxrss_b` 计数。探针件数以卷内键集为准（扩件版 `det_proof_r44.json`），**不得用口头件数或口头字节替代**。
- **2GiB 只作诊断**：A/B 器每件设 `CHENG_PROCESS_MAX_RSS_BYTES=2147483648`（`ab_run.py:7`），只用于探索/同窗相对；达标口径仍是 768MiB 静窗（§1.1）。探针卷件数以卷内键集为准（不在本文复写件数），不得用口头件数替代。

## 1. 确定性内存管理模型

### 1.1 门与判定三判据（同时成立才算绿）

1. 总峰 ≤ **805,306,368 B（768MiB）**，守卫恒定，**禁止抬门/放宽换 rc=0**（排墙诊断轮可抬门，但必须 `--diagnostic` 硬标 `DIAGNOSTIC_NOT_ACCEPTANCE`，永不入达标账）。
2. **逐相贴线**：每相实测 RSS 与模型预算差 **>50MiB 必须解释**，解释必须落到模型项（哪一相/哪个模型项/±多少字节），禁止"基座演化"式手挥。
3. rc=0。

### 1.2 模型项斜率表（截至 2026-09-24 实测锚；锚随刀更新）

| 项 | 定义 | 斜率/总量 | 备注 |
|---|---|---|---|
| T(k) | typed facts 域驻留带 | **390–430MB**（N2 钉死） | 判点窗不物化（合并森林单份已删，消费改逐源流式）——对账时按此口径 |
| R(k) | reachable set 逐函数 18 列 SoA+闭包扫描簿记 | **0.326–0.328 MiB/源**（=4,685–4,704 B/函数；234 源锚 76.3–76.6MiB） | 全程驻留无中途释放=merge floor 组成项；resident/transient 分解=⑥（2026-09-24 已闭，见下） |
| X2 | metadata contexts 段 | **段净 473,175 B/源**（贴线锚）/步进 445,729 B/源 | 旧价 645KB/源作废；451KB/源=分母滑差勿用 |
| B1 | merge pass-0 解析 spike | **spike = u + old(u)**（倍增拷贝瞬态；D6 精确 reserve 后 =u+bump≈5.6MiB） | `sourceArenaReserve=0` 已修；u 带：typed_expr 134.1MiB 实测（109.7–163.5） |
| C2 | 回放池 | 池账 92→**34.8MB**（免重解析 −55.3s 同域） | |
| M-new | 基座演化前端/measure/profiles 相净驻留增量 | **+34,401,521 B ≈ +34.4MB（32.8MiB）挂 pending 桶**（modelaudit 对账线 2026-09-22 开项） | 落 F/T(k)/G(k)/B1/B2 域，待钉（同窗 A/B 或行数探针钉值）；**禁摊入既有项当噪声** |
| ⑤ | 行数计 | 待读数轮 | 未钉项**不得当 0、不得用估计值充数** |
| ⑥ | R(k) resident/transient 分解 | **已闭（2026-09-24，域级+块级均有账）** | arena 四字段账 14 对 29,951 行：巨型 churn freed==alloc 全释放（parser_tree 单实例峰 140.6MiB、全 tag 累计 2048MiB），查询域 parser_scratch 总 churn ~4MiB 已是瞬态量级，done 时驻留仅 forest/typedIr 产品 store（~101MiB 设计驻留）⇒ P3 子 arena 瞬态化**无病不治不落刀** |
| floor 组成 | pass-1 环入口 | 实测锚 **740.7MiB**（2026-09-24 memb3d gen23 门轮 b3 臂 776,619,088 B，爬深 src=159；F1 修+内存三批落库后，旧锚 713.2=604.2+105.6+3.5 作废） | 带内=merge 相内存顶；基座演化致漂移 >50MiB 必须逐项归因（禁手挥） |
| 探针实测锚 | fourfam 逐件 RSS | **不变量：全件 `cap_respected=true`（maxrss ≤ 768MiB 门）；峰值/区间/占门比现算自卷内 `maxrss_a/b`，表内不复写** | 卷 `.c0run/core0prod/fourfam-r40/det_proof.json`（+`det_proof_r44.json`）；2GiB 帽仅诊断（§0.6） |

### 1.3 d_live 与 rss 不可互换

- `rss`/峰值：找**峰值贡献者**（含瞬态——B1 倍增拷贝类瞬态 d_live 不可见，parse 窗仅 +952 块）。
- `d_live`：找**谁留住了**（真实工作集；留住者例=X2 metadata contexts +124.4MiB）。
- 内存读数**只可同窗口相对比较**；跨窗数字仅作结构归因。

### 1.4 仪器权威表

| 判定 | 权威通道 | 辅助 |
|---|---|---|
| 峰值/贴线 | **C-rusage（`/usr/bin/time -l` maxrss，wait 链折叠，Darwin 单位=字节，零盲区）+ beat_c v2 footprint 双列取 max** | ps 采样仅下界（2.3s 网格有相界盲区，"ps 未触发⇒门内"推定已作废） |
| 超门执法 | 驱动内 `CHENG_PROCESS_MAX_RSS_BYTES=805306368`+INSTANT+HF fail-stop；beat_c v1 正式执法链 | rusage 模式与正式身份栈互斥硬拒 |
| 逐相计时 | csg_stage tag 序列收割（`harvest_phases.py`，坑①首条 since_ms=绝对时戳不入时长和、坑②全墙只吃真实墙钟） | Σsince_ms 与墙差显式报 gap |
| 全机并发准入 | **`tools/mem_slot.sh` acquire/release（预算记账信号量，全机 Σ≤8GiB 常量，超限 rc=3 排队）** | ≥2GiB 诊断轮/爬墙/门轮强制领取（§1.6）；编译烤轮走 `tools/compile_admission.sh` 三级准入（§1.6） |
| 驻留/瞬态盲区（⑥类，逐 arena） | **arena 四字段账探针**（`arena_acct_probe_v3i`，CHENG_ARENA_ACCT=1：逐 arena allocated/capacity/peak_used/freed 逐窗快照 arena_acct_row） | 分析器 arena_acct_top.py/delta.py（仓外 `~/cheng_evidence_offsite/memb3d_line_20260924/`）；⑥双点字节账探针（facts/binding/ir 三 kind）之外盲区的补测仪器 |
| 编译绿同窗 A/B | **`.c0run/r37/ab_run.py`**（逐件 obj 细面，现役驱动 W=10/KT=180，四 chunk）+ **`.c0run/r19/gate_ab.sh`**（全量 1503 逐件 census 守门） | 两车 sha+seed sha+语料 sha 三钉；选型与判定面见 §0.3 |

### 1.4.1 嵌入模块（模型约束 source 即得；modelflow 线 2026-09-22，三历史窗校准全绿）

预算表唯一权威 = `tools/memory_model_enforce.sh`（`MODEL_BUDGET_TABLE`：逐相/模型项/预算字节/斜率依据/出处；⑤⑥ 标 UNPINNED 不当 0；M-new +32.8MiB 挂 pending）。对账器 = `tools/harvest_model_check.py`（解析同一表，不另立数字）。quietwin v3.1 已接线（harvest 后自动对账，对账破绿 ⇒ verdict 破绿）；he-line 等既有 baked 链侧一行接入：`source tools/memory_model_enforce.sh && model_gate "$rc" "$tsv" "$peak"`。用法三行：

1. `source tools/memory_model_enforce.sh` → `model_budget <phase>` 查预算行；`model_check <phase> <bytes>` 三态判定（PASS ≤预算 / PASS_TOL ≤+50MiB 容差 / WARN 差 >50MiB EXPLAIN-REQUIRED / FAIL 超门 / UNPINNED-EXPLAIN-REQUIRED）。
2. `python3 tools/harvest_model_check.py reconcile <gate_stderr> --out-tsv P` → 逐相对账表 + 窗账归因（X2/R(k)/TypeArena/骨架/scan 步长差 → M-new pending 桶 → 候选残留）+ M-new 候选探测（无法归项的新增驻留自动标记）。
3. `python3 tools/harvest_model_check.py verify_calibration` → 三历史窗回放（W1 floor 713.2 九点逐字节+分解闭合 / W2 758.3 拆 X2+12.5+M-new+32.8 / W3 2.31GiB+orcd12m FAIL 复现）；非 0 即嵌入破损，禁出达标结论。

### 1.5 逐刀预算声明模板（派单/建刀硬门槛）

每把刀进烤前必须声明：**哪一相 / 哪个模型项 / ±多少字节**（依据=census 斜率或同族先例；无数据给上界并标"待门轮校准"）。预算超门即打回重设计，不许烤了再看。三口径分账：静窗（唯一入达标）/负载窗（只可同窗 A/B 相对）/抬门诊断（永不入账）。轮次资源行：≥2GiB 轮（诊断/爬墙/门轮）必须先 `tools/mem_slot.sh acquire <budget_gib> <owner_name>` 领闸（EXIT trap release），预算声明须带 budget_gib；编译烤轮走 compile_admission 分级准入免领取（见 §1.6）。

### 1.6 全机编译准入：mem_slot 预算闸 + compile_admission 三级准入 + driver_cache 内容寻址缓存（65GB 崩机根修 3f403bf96；编译槽分级 slotopt 线 2026-09-25）

- **mem_slot（内存预算闸，机制不变）**：≥2GiB 的诊断轮/爬墙/门轮一律先 acquire 再跑；全机 Σ≤8GiB 常量，超限 rc=3 排队；记账 `.rebuild/MEM_SLOT/`，stale(mtime>2h) 自动清；mkdir 原子+owner.txt+只偷死锁（工艺细节见 `tools/mem_slot.sh` 头注）。
- **compile_admission（`tools/compile_admission.sh`，三级准入）**——COMPILE_SLOT 全树串行曾是最大阻塞，铁律改写为「**测量轮独占 + 烤轮分级并行**」：

  | 道 | 准入对象 | 并行语义 | 记账 |
  |---|---|---|---|
  | probe | 单源、预估 <1GiB 且 <120s | 免互斥槽 | mem_slot 记账（预算按 1GiB 保守计费，真实字节入票名与台账） |
  | build | 驱动烤与构建 | budget_gib=1 小烤 ≤3 并行；budget_gib≥2 大轮准入内独占 | mem_slot 按尺寸分级记账，Σ≤8GiB 强制 |
  | measure | 门轮/静窗测量轮 | 独占静默机（原 COMPILE_SLOT 语义） | 持 `.rebuild/COMPILE_SLOT.lock` 目录；≥2GiB 轮另行 mem_slot 预算闸 |

  - **兼容别名（存量脚本零改动）**：`.rebuild/COMPILE_SLOT.lock` 目录=measure/旧客户端独占锁（mkdir+owner.txt 协议原样）；probe/build 持票期间在同一路径落**普通文件**标记——旧客户端 mkdir 必败即排队、取不到 owner pid 则偷锁分支永不误触、`darwin_build_pair.py` 的 exists() 早拒同样被挡。
  - **测量优先排水**：measure 排队落 `MEASURE_PENDING`，probe/build 见之即拒，在飞票排空后原子转换（删标记→mkdir 独占）；与旧客户端的转换竞窗退避重排，绝不 rm 他人锁。
  - **类硬限（admitcap 线 2026-09-27）**：作业类时长硬限做进本闸机械执行——`--timeout-secs T` 声明即由本闸 `timeout` 包裹（子进程组 SIGTERM，15s 后 SIGKILL），到点透传 124：probe 类强制 ≤5400s（90min），声明 >5400 rc=4 拒绝改类，未声明自动按 5400s 包裹（存量调用零改动+stderr 迁移提示）；build 类单烤 ≤5400s（既有 BAKE_TIMEOUT 档），声明超限 rc=4 拆轮，未声明不包裹；measure 类独占不变，声明即包裹无上限，未声明不包裹；配套修 `wait_measure` 丢 `--no-wait` 既有缺陷（此前 measure 的 --no-wait 被静默忽略）。
  - **形态**：run 形态包住真实负载（`compile_admission.sh <lane> … -- <cmd>...`），EXIT trap 释放、透传 rc；票目录 `.rebuild/COMPILE_ADMIT/`；死主独占锁双确认才偷（mem_slot 同款）。env `COMPILE_SLOT_PATH/COMPILE_ADMIT_DIR/MEM_SLOT_DIR` 仅供测试隔离，生产不设。
- **driver_cache（`tools/driver_cache.sh`，内容寻址驱动缓存）**：键=`stage3sha-treecid-driversrcsha`（treecid 用 `tools/current_source_closure_manifest.py` 现成 CID 机器按驱动烤制输入闭包计算，scope 惯例同 backend2 gate＝bootstrap src cheng-package.toml cheng.lock.toml docs/cheng-formal-spec.md .gitignore tools；`--root` 须为 git 仓）。**get 复用前全键复核**＝当场重算三键+provenance 全键字段比对+驱动二进制 sha256/字节数复核，任一不过 rc=6 fail-closed 并 quarantine，**stale 假绿零容忍**；put 幂等（同内容 DUP 放行），同键异内容=碰撞硬失败绝不覆盖；run=miss 则烤（DC_OUT 交付路径）→put→复取复核，链上任一环失败即硬失败。库 `.rebuild/driver_cache/` **跨任务保留**——此为「冷对象缓存不得跨任务保留」铁律的**修订案**：键纯内容寻址（不含时间/任务身份），复核在取用侧强制执行，staleness 无生存面（提交文载明，待用户追认）；clean 只清 quarantine/staging 残骸，永不自动逐内容。
- **根因教训（不变）**：无全机准入的并发聚合=65GB 崩机根因，无槽裸跑=复发条件；分级准入后任何编译负载仍必先过闸（probe/build/measure 三道之一）或 mem_slot（≥2GiB），禁止绕闸裸跑。

## 2. 编译时间模型

### 2.1 L1 定义与判据

- **L1 = 234 源闭包口径 [199,209]s**（C 链参照轨：b102 parse 136.997679s，占65.75%，不是65.75s；codegen 66.2–66.4s / 中位 202.0s；原始分解见 `time_model_structural.md` §4.1）。
- 判据 A = W_impl/W_algo ≈ **2.0×10⁵**；判据 B = **13.70**（并行未起来的后验效率倒数，非算法下限）；判据 C 停用（52–60s 被 typed-facts 实测 1348–1463s 证伪 ≥40×）。
- **判据 B 不是 M4 兑现刀**：L1 分母本身是串行 C 链 wall，并行属 L3 档。

### 2.2 逐相时间表（自宿主轨，负载窗读数；静窗待五项一发回填）

| 相 | 实测带 | 备注 |
|---|---|---|
| 计划/绑定 | 8.9–11.7s | |
| profiles 二遍解析 | 32.1–51.7s | 同一文本 7 遍独立走+651k 行短串 churn（收敛刃 P1 在案） |
| reachable | 5.9–9.3s | R(k) 项 |
| X2 构建 | 28.0–46.4s | 84.6%=TypedExprBuildMetadataContextFromProfile |
| 并林窗 | 260.7–397.2s（最大相） | 对 C parse 溢价 ≈+107s；C2 回放已 −55.3s；结构地板=每源 2 次全量解析不可再减 |
| typed facts | 修①前全相 1348–1463s | 对 C codegen ≈20–22×（算法性真巨口）；decl-loop 增量化 D1-D4 设计在案（−438s 档） |
| 未归段 | 31.4–58.8s | |

### 2.3 缺口账与判定

- 刀路全落地预期全墙 ≈486s（负载窗定序口径），vs 209 剩余 ≈277s（落点=并林窗余量+profiles 邻段）。
- **M4 三态判定**（JUDGE_M4）：PASS / FAIL / 待复测——全墙 ≤209s 静窗读数为达标唯一口径；负载窗读数只定序不定谳。
- 烤机病理铁律：机器空闲窗烤制 >10 分钟即病理；重载窗只放大标度不改结构（parse/codegen 占比恒定可证）；一切烤制读数入账前先钉**驱动 binary sha** 与窗口口径。
- 长烤纪律：烤段用分离 runner（nohup disowned+pid+心跳+主动轮询，双 fork+setsid 防 reaper）；60min 后台帽内拆段。

### 2.4 嵌入模块（2026-09-22 入库：`tools/time_model_enforce.py` + `tools/harvest_time_check.py`）

时间侧机械执行模块，与内存侧 memory_model_enforce/harvest_model_check（在飞）对称：同一张 harvest_phases 逐相表（同源同管线），口径标签机械化——前置三检（lane/gui/canary）全 PASS 且无 `--diagnostic` ⇒ QUIET-VERIFIED，否则 LOAD-WINDOW；总墙三态 QUIET-VERIFIED∧≤209s=PASS／QUIET-VERIFIED∧>209s=FAIL／LOAD-WINDOW=SEQUENCE-ONLY（只定序不入账，死墙/被杀全墙不判 FAIL，缺墙=NOT-JUDGEABLE）；七相带表（§2.2）越界=OUT-OF-BAND 信息旗非 FAIL；病理哨（C 链锚 >600s／parse 占比漂移 ⇒ PATHOLOGY-FLAG）；判据 A/B 常量核对清单恒输出。校准=幸存 gate 原始件回放：te5 281s/orcd12m 413s→SEQUENCE-ONLY、预-森林 192–199s<202.0s 定序复现。

三行用法（quietwin v3 harvest 后接线）：

```
python3 .rebuild/quietwin3_line/harvest_phases.py harvest "$STDERR" --wall-s "$WALL_S" --out-json "$OUT/main.phases.json" --out-txt "$OUT/main.phases.txt"
python3 tools/harvest_model_check.py check --phases-json "$OUT/main.phases.json" --wall-s "$WALL_S" --out-txt "$OUT/MEM_VERDICT.txt"   # 内存侧（在飞，落位后此行即活）
python3 tools/harvest_time_check.py check --phases-json "$OUT/main.phases.json" --wall-s "$WALL_S" --precheck-lane-file "$OUT/precheck_lane.txt" --precheck-gui-file "$OUT/precheck_gui.txt" --canary-file "$OUT/canary.txt" [--diagnostic] --out-txt "$OUT/TIME_VERDICT.txt"
```

一行双检形态：`python3 tools/harvest_time_check.py dual_check …`（同表先调内存侧、再落时间侧）。校准重跑：`python3 tools/harvest_time_check.py verify_calibration`。接线样例：`.rebuild/timeflow_line/TIMEFLOW_DELIVERY.md`。

## 3. 权威文档指针

- 内存唯一约束卡：`docs/campaigns/2026-08-31-kernel-userpath/design/memory_model_constraints.md`（R(k)/X2 价/待钉区⑥ 均已入卡）
- 时间模型定谳：`docs/selfhost-resource-plan.md` §九（TM1/TM2）
- M4 判定法+静窗仪器：`.rebuild/quietwin2_line/`（quietwin_retest.sh + JUDGE_M4.md + DATA_LEDGER.md；防 GC 同步 `~/cheng_evidence_offsite/`）
- 三通道权威表：`.rebuild/guardv2_line/CHANNEL_AUTHORITY.md`（灭失时看板 §仪器栏转述）
- 战役总看板：`docs/campaigns/2026-08-31-kernel-userpath/design/milestone_board.md`
- 证据镜像档：`docs/campaigns/2026-09-20-kernel-slab-pass1/archive/`
- M-new 开项对账：`docs/campaigns/2026-09-20-kernel-slab-pass1/archive/modelaudit_line_MODEL_AUDIT.md`（floor 漂移逐字节闭合+M-new 钉死所需读数）
- 全局内存准入闸本体：`tools/mem_slot.sh`（交付全账在 commit 3f403bf96 提交文；线目录已 GC，本体在库即权威）
- ⑥关闭判决+arena 四字段账：仓外 `~/cheng_evidence_offsite/memb3d_line_20260924/MEMB3D_STATE.md` §四（落库栈=78e6544d1；仪器三章同目录）
- Wall A 定谳（Seal 所有权合同面）：`docs/campaigns/2026-09-22-cold-retire/receipts/sbview3/SBVIEW3_STATIC_REPLAY.md` §二/§三——守卫=buildIndexOwned/异索引即拒、投影 pass1 强制全员借用同一 index；deferred-core 出口 `SetOwnedBuildIndex(contexts[0])` 必持 owner 位=早期投影调用对任何编译必死；根修序=**Seal 内先建 projection（全员 borrower 成立）→ 才换手所有权（handover reuse 臂验证）**，序不可倒（行号随快照漂移：4476 基守卫 :42158、832 基守卫 :42305/Seal :47301 区，以权威档为准）；落库 832ebbbda
- Wall A 解析权威形态：方案 2+3（resolve sourceContexts 穿线+import 回填）动态不足——fallback 已接线仍撞 sha256:443 形（findings 53）；**方案 1 全局累积 call-declaration 索引=结构终态**（walla1 刀 v3 独立烤制 rc=0 判词消失第二实现交叉印证，冻结移交备援）：`docs/campaigns/2026-09-22-cold-retire/receipts/walla1/WALLA1_STATIC_REPLAY.md` §一
- 2026-10-25 现势与判例卷：`findings.md` 第42–45轮（`:1856-1886`）——同窗 A/B 口径（绿数不复写，最新以第45/46轮为准）、0 新绿判例、纯插入核验、2358/1:13 定谳、阻塞账
- 编译绿 A/B 卷：`.c0run/r45/kernel/ab/`、`.c0run/r46/kernel/ab/`（逐 chunk `ev_1503_*.jsonl.summary.json`）；全量 census 门 `.c0run/r19/gate_ab.sh`
- fourfam 内存探针卷：`.c0run/core0prod/fourfam-r40/det_proof.json`（+`det_proof_r44.json`、脚本 `det_proof.py`）
- item3 迁移/纯链先例：`.c0run/r44/migrated/README.md`（`harness/run_all.sh`）

## 4. 铁律速查

1. 门值只是标量，模型才是诊断仪器；逐相贴线 >50MiB 必落到模型项。
2. 未钉模型项不得当 0、不得用估计值充数；外推超门即缺陷。
3. d_live（谁留住了）与 rss（峰值贡献者）不可互换。
4. 静窗唯一入达标；负载窗同窗相对；抬门诊断永不入账。
5. 每刀进烤前：逐相内存影响声明（哪相/哪个项/±字节），超门打回。
6. 时间读数同纪律：钉 binary sha+窗口口径；`three_bake_disasm_equal` 类口径伪差以 byte sha 为准。
7. 判等/归因禁止排除法替代仪器命中（地址级逐字节才可定谳）。
8. **≥2GiB 轮必先过 mem_slot**（65GB 教训：无全机准入的并发聚合=崩机根因，无槽裸跑=复发条件）；一切编译负载过 compile_admission 三级准入——**测量轮独占 + 烤轮分级并行**，驱动烤制复用走内容寻址 driver_cache（复核不过 fail-closed，见 §1.6）。
9. **8GiB 爬墙禁飞**：健康载具绑定相回 ~0.66GiB（内存战役落地）前，768MiB 门爬墙不可行；落地后自动解除。
10. **编译绿只认同窗 A/B**：先钉两车 sha + seed sha + 语料 sha，再跑 `ab_run.py`（细面）与 `gate_ab.sh`（全量守门）；跨轮数字不可直接相减（旧树峰值/中间读数非现势），绿数最新以 `findings.md` 第45/46轮为准。
11. **0 新绿不单独落树**：只前移墙/机械消错的批次与下一刀捆绑；编译面+运行面正确性批次（obj→纯链→run 全绿、双烤对象 sha 恒等、负例判词重基线）可另立判据。
12. **对象差先判“纯插入”**：逐件移除新增指令后与 BASE 逐条比对，相等才算纯插入；不得把对象差直接当语义等价。

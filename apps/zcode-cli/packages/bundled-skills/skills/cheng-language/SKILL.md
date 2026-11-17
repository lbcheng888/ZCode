---
name: cheng-language
description: Cheng 语言合法面与日常操作手册。凡在 cheng-lang 仓写、改、审 .cheng 源码，新建复现/门禁夹具，用 core0 车做单件 obj 编译，做 C 冷律对照，或核对 pe/ov 判词时自动触发。覆盖 var/let 零默认禁令与 v4.0 统一 `:` 借用契约（x: T / x: var T / x: own T + move，: T / : view T / : view(x) T；禁用 ->、: own T、前缀 own x: T 与 borrows/borrow_result/escapes）、指针禁令与 provider/ABI 边界、标量/定长数组/动态序列/名义结构/Result-Option 写法、包根与 import 约定（cheng/ 前缀、cheng/kernel/ 单源模块根）、fixtures 位置与跑法、常见坑。
---

# Cheng 语言合法面与日常操作

## 0. 口径

- 权威顺序：`docs/cheng-formal-spec.md`（语言唯一权威，spec:6-8）> `kernel/spec/INTERFACES.md`（kernel 合同与已冻结缺口）> `findings.md`（战役判例）。语言条款冲突时以 spec 为准。
- spec:263 硬规：实现尚未支持的合法形式必须补齐，**不得改写业务源码规避**。
- 本树缺件（实测）：spec:6 起引用的 `docs/cheng-implementation-status.md` 与 spec:685 引用的 `docs/beat-c.md` 不存在，不要当可读依据；kernel 合同看 `kernel/spec/INTERFACES.md`，战役账看 `findings.md`。
- 两种「绿」分开：spec 合法面（语言法）与 core0 车当前 subset（车法）。车绿不等于 spec 合法，spec 合法也不等于车绿；见 §5 第 1 条。

## 1. 合法面铁律

### 1.1 带类型标注的 let/var 禁止显式零默认

- 禁止 `var x: int32 = 0`、`let n: int64 = 0`、`let b: bool = false`、`var s: str = ""`、`var a: T[] = []`、`var x: T = T()`；零值由类型隐式提供，写 `var x: T` / `let x: T`（spec:645）。
- 非字面量等值形同禁：`= T()`、`= []`、`= nil`（spec:646）；字段/元素默认值也禁止重复声明隐式零值（spec:647）。
- 隐式默认值：`bool=false`；`int8/16/32/64/int`、`uint8/16/32/64/uint`、`enum=0`；`float=0.0`；`char='\0'`；`str/cstring=""`；`ref object=nil`；`T[]`=空序列；`T[N]`=N 个零元素（spec:632-640）。
- `T()` 只用于 `object/tuple/Bytes` 的默认值物化；`int32()`/`bool()`/`str()`/`T[]()`/`T[N]()` 非法（spec:630, 688）。
- 判词：`explicit typed default` = pe20（文本表 `kernel/parse/core0_cli.cheng:181-183`；号表 `kernel/parse/parse.cheng:30`）。当前种未执法（§5 第 1 条实测），但 spec 条款不因车放行而改变。

### 1.2 v4.0 统一 `:` 契约与 let/var 语义

- 传参统一 `:` 后置修饰符（`x: T / x: var T / x: own T`）：未标注 `var`/`own` 的受管形参 `x: T` 默认为**共享只读借用**（`BORROW_SHARED`）；`x: var T` 为独占可变借用；`x: own T` 为消费式移动所有权转移（调用点写 `move a` 或传右值；禁止前缀 `own x: T`）。
- `var` 形参/绑定 = 可变借用，不转移所有权、不加引用计数、不得逃逸；调用侧隐式建立借用，物理地址只在借用证明完成后的 ABI lowering 内瞬时产生（spec:56）。
- `share` 用于同线程共享；跨线程用 `share_mt`/`Arc[T]`；不做隐式拷贝（spec:57）。写入全局/长生命周期容器必须是可共享值，不能直接存 `var` 借用（spec:58）。
- 借用独占：借用活跃期禁止对借用源读/写/再次借用（spec:69）；借用值禁止 `return/yield`（除非函数声明 `: view T` / `: view(x) T`）、写全局、传给 `x: own T` 形参、进 `share`（spec:71）。
- `let` 不可写：判词 `immutable binding` = pe21（`kernel/parse/core0_cli.cheng:184-186`）；负例 `src/tests/fixtures/repro/r25_n1_let_write.cheng`、`src/tests/fixtures/repro/r25_n2_let_field_write.cheng`。
- `defer` 唯一合法形 `defer: suite`；严格 LIFO；suite 内禁 `return/yield/break/continue/await` 和嵌套 `defer`（spec:45-51）。

### 1.3 `: view T` / `: view(x) T` 与 `borrows` / `borrow_result` / `escapes` 退役

- 返回默认 `: T` 即 Owned 新值（禁止 `->` 返回箭头与 `: own T` 返回）；返回既有存储的借用视图必须写 `: view T` 或 `: view(x) T`（如 `fn ErrorMessage(e: ErrorInfo): view str`，若带 `(x)` 则 `x` 必须为函数已声明形参；`importc` 或缺失摘要的 managed 返回按 Unknown 硬拒，spec:74）。
- 借用值可传给默认共享借用形参 `x: T`，禁止传给 `x: own T` 消费形参。
- 旧显式 `borrows`、`borrow_result`、`escapes` 注解已在 v4.0 退役（严格模式 `CHENG_STRICT_V4=1` / `--strict-v4` 硬拒），禁止在新源码中使用；迁移与检查使用 `tools/cheng_v4_canonical_migrator.py`（`--check` 检出、`--apply --migrate-v3-borrow-surface` 一次性迁移）。
- 借用活跃时的未知/未解析调用按编译期硬错误处理（spec:73）。

### 1.4 指针禁令与 provider/ABI 边界

- 默认公开口径下用户源码禁指针，`@importc/@exportc` 不豁免：禁 `T*`、`void*`、`ref T`、`ptr[T]`；禁 `*`/`->`/`&`、`dataPtr/getPointer`、`ptr_add/load_ptr/store_ptr`、`copyMem/setMem/zeroMem`、`alloc/dealloc`（spec:59-61）。
- 合法保留面是受管句柄形：`type X = ptr` 别名、句柄字段/形参/返回/局部、与 `nil` 比较/赋值是合法直觉语法；身份=int32 表索引的 8B 值载体，不是裸指针。取址/解址/地址算术/raw load-store/整数伪造句柄一律 pe24/25（spec:62）。
- 表面无裸指针；`ref object` 是对象种类不是裸指针；FFI 物理地址只在已证明 ABI 边界内瞬时产生（spec:157-159）。
- C ABI 只走影子桥：`T[]`+`@ffi_map`、`utf8_view`、`bytes_view`、`cstring`、`owned_cstring`+`@ffi_owned_result`、`@ffi_out_ptrs`、`@ffi_handle(unwind=no_unwind,...)`、`@importc + var T`（spec:606-616, 822-827）。
- provider 边界：物理地址/裸访存只属于 kernel/运行时 provider 源与 ABI lowering；`kernel/spec/INTERFACES.md:34` 明说该地址是「后端物理实现，不是公开 Cheng 指针类型或操作的例外」。provider 形夹具示例 `src/tests/fixtures/gates/g186/m1.cheng`（`type probeP = ptr`，注释标 provider）；业务源码不得照抄。
- 用户面判据：`&x`/`*p` 实测 pe25（§4.1 命令，`error:3:12: pointer operation forbidden in core0 subset`）。

## 2. 类型与容器写法

### 2.1 标量

- 日常标量：`int32`、`int64`、`uint8`、`bool`、`str`（默认值见 spec:634；`str` 布局见 spec:682）；默认值规则见 §1.1。
- 声明用省略初始化：`var i: int32`（spec:631）；非零初值写 `var n: int64 = int64(4)` 或先声明再赋值。
- `str` 是业务文本唯一类型；`cstring/utf8_view/bytes_view/owned_cstring` 只作 C ABI 边界（spec:651）。`str = nil`/`x == nil` 编译期错，判空写 `len(s) == 0`（spec:652-655）。字符串 `+` 已移除，用 `Fmt"..."`/`Join`/`Lines`（spec:597）。
- `str` 布局 24B（`data@0`/`len@8`/`store_id@12`/`flags@16`）；`str[]`/`uint8[]` 是 16B 序列头，禁止混用（spec:682-684）。
- 本车实测：bool/int32/int64/uint8/str 的声明、赋值、比较与 `len(s)` 单件 rc=0（§4.1 同一命令）。

### 2.2 T[N] 定长列

- `T[N]`：N 是编译期常量，类型身份与 ABI 都含 N，inline 布局，零值=N 个零元素，没有 len/cap/buffer（spec:604, 640）。
- 写法：`var fixed: int32[2]`，下标读写 `fixed[0]`；动态索引恒有界检查，只有精确 value-definition + 常量范围证明才可消去（`kernel/spec/INTERFACES.md:35`）。
- 夹具：`src/tests/fixtures/repro/core0_fixed_array_byval.cheng`（int32[4]/int64[4]/bool[4]/uint8[4]/float64[4]）、`src/tests/fixtures/repro/core0_generic_fixed_arrays.cheng`（`T[4]`/`U[FixedLen]`）。
- 本车实测：`var fixed: int32[2]` + 下标读写 rc=0。

### 2.3 T[] 动态序列

- `T[]`：运行时 `len/cap/buffer`，可扩容；零值=空序列；带类型标注省略初始化即空序列（spec:603, 640）。
- 字面量 `[]`/`[a, b]` 需要类型上下文；空 `[]` 不能作无类型独立表达式（spec:592, 691）。
- 旧语法 `seq[T]`/`openArray[T]`/`array[...]` 已移除（spec:605）。
- 现状：core0 车对局部 `int32[]` 仍 pe17（`kernel/spec/INTERFACES.md:369` 明确 `int32[]`/数组初始化器 fail-closed；本车实测 `var xs: int32[]` → `error:15:18: unsupported formal subset`）。语言形按 spec:603，不要为绕车墙改源码（spec:263）。

### 2.4 名义结构

- 声明：`type Point = object` + 缩进字段，或省略 `object` 的隐式对象体；`ref object of Base` 的 base 必须是具体 nominal object（spec:286-311）。
- 字段可带默认值；初始化顺序固定：类型零值 → 字段默认值 → 显式构造实参（spec:641）。
- 构造：`T(field: value)` 或 `T { field: value }`；字段名唯一，unknown/duplicate 都硬错（spec:648-649, 692）。
- 夹具：`src/tests/fixtures/repro/r25_n1_let_write.cheng`（Slot 结构）、`src/tests/fixtures/gates/g168/c1.cheng`（泛型 `R[T]` 名义结构）。
- 本车实测：`type Point = x/y` + `Point(x: 3, y: 0)` rc=0。

### 2.5 Result / Option

- `Result[T] = {ok: bool, value: T, err: ErrorInfo}`（`src/std/result.cheng:9-13`）；构造 `Ok[T](v)`/`Err[T](msg)`（`src/std/result.cheng:50-58`）。
- `Option[T] = {has: bool, value: T}`（`src/core/option.cheng:2-5`）；`Some[T]`/`None[T]`/`IsSome`/`Get`（`src/core/option.cheng:6-22`）；std 门面 `import std/option` → `src/std/option.cheng`，其内部 `import cheng/core/option`（`src/std/option.cheng:2`）。
- postfix `?` 解包失败即提前返回/传播；`return expr?` 非法，先 `let v = expr?`（spec:756-757）。
- 现状：本车 `import std/result` 失败，首判 `error:10:10`、后续 `error:15:52`/`error:18:55`（行号对应 `src/std/result.cheng` 的 `type` 与两个 helper 声明）；core0 单件校验宜用本地名义结构模拟 Result（如 `src/tests/fixtures/gates/g168/c1.cheng` 的 `R[T]`），不要把 std 模块当成车绿前提。

## 3. 包与 import

- 包根固定 `cheng-package.toml`，必须有 `package_id`；锁文件 `cheng.lock.toml`（spec:787-788）。本仓：`package_id = "pkg://cheng"`、`module_prefix = "cheng"`（`cheng-package.toml:1-2`）。
- `import <pkg>/<path>` 推荐；`cheng/<pkg>/<path>` 是等价兼容别名（spec:793）。只接受归一化模块路径，禁字符串/绝对/相对路径、禁空格（spec:792）。
- 包内模块根是 `src/`：`import <pkg>/<path>` 映射到 `<pkgroot>/src/<path>.cheng`（spec:795）。所以 `import cheng/core/option` → `src/core/option.cheng`（文件在位，`src/std/option.cheng:2` 实引）。
- 标准库统一 `std/<path>` → `src/std/<path>.cheng`（spec:797）；例如 `import std/result` → `src/std/result.cheng`。
- 导出 Go 风格：首字符 ASCII 大写才导出；小写/`_` 私有（spec:780-783）。导入图禁环（spec:803）。分组 `import pkg/[a,b]`，分组不支持 `as`（spec:799-800）。
- 镜像：`kernel/` 是内核正本，`src/core0_stage/` 是镜像。按装配脚本口径，车/夹具沙箱用 `kernel/` 覆盖 `src/core0_stage/`（`tools/seed_argv_adapter.sh:88`；`.c0run/r45/kernel/bake_snapshot.sh:17-19`）。改 `kernel/` 必须同步镜像并逐字节核对。
- fixtures 位置：所有复现件/门禁用例放 `src/tests/fixtures/repro/` 与 `src/tests/fixtures/gates/g<round>/`，不得再占 `src/` 根（`src/tests/fixtures/README.md:3,6-7,14`）。夹具互相 import 必须写全路径 `import cheng/tests/fixtures/{repro,gates}/<dir>/<mod>`（README:10）。

## 4. 日常命令

### 4.1 core0 车 obj 编单件

```sh
W=$(mktemp -d); mkdir -p "$W/od"
printf '%s\n' "$PWD/src/tests/fixtures/function_task_simple.cheng" > "$W/m.mf"
env CHENG_PROCESS_MAX_RSS_BYTES=2147483648 TMPDIR="$W" LC_ALL=C \
  ./artifacts/bootstrap/cheng.stage3 obj "$W/m.mf" "$W/od"
```

- manifest 一行一个源文件（`tools/core0_census.py:27`；`tools/seed_argv_adapter.sh:97-102`）。
- 需要包解析（含 `import`）的源必须落在包根内（cwd 有 `cheng-package.toml`）；无 import 的单件放 `/tmp` 可编译（实测 rc=0）。含 import 的 `/tmp` 源 rc=2 `selfhost: package root not found`。
- 产物 `<base>.o` + `<base>.tok` + `<base>.ir`；判据=rc=0 且 `.o` 非空（`src/tests/fixtures/README.md:12-13`；`tools/seed_argv_adapter.sh:110`）。
- 本次实测：`function_task_simple.cheng` rc=0，产出 1175B `.o`；负例 `src/tests/fixtures/repro/core0_immutable_binding_negative.cheng` rc=1，首判 `error:3:12: immutable binding`。
- 车身份要钉：现槽 sha `268d237c…`（`artifacts/bootstrap/cheng.stage3`）；夹具期望 rc 随车 sha 变（§5 第 9 条）。

### 4.2 fixtures

- `src/tests/fixtures/`：无 runner，按 4.1 逐件编。正例 rc=0；非法形负例 rc=1 且首判非空（`src/tests/fixtures/README.md:13`）。批量沿用同一 per-file 循环即可（本次逐件跑过多件）。
- `kernel/fixtures/`：`bash kernel/fixtures/run_fixtures.sh`，内容是 F1-F4 golden tokens/ir diff + 线性三拒绝 + ptr 硬 fail（`kernel/fixtures/run_fixtures.sh:6-13`）。
  - 本次实跑：**未通过**（rc=1，`SUMMARY pass=0 fail=14`）。失败点是环境缺 GNU `timeout`：`compile_admission: FAIL_CLOSED 类硬限需 timeout(GNU coreutils) 机械终止, PATH 中无 timeout`；随后用例因 `core0_cli` 未产出而 rc=127。装 coreutils 提供 `timeout`/`gtimeout` 后重跑，不要把这次失败读成语言回归。
- 注意：`src/tests/fixtures/README.md:18` 的「已验证」绑定当时集成车 `2e458940`；本次用现槽 `268d237c` 跑 `src/tests/fixtures/gates/g168/c1.cheng` 得 rc=1 `error:7:5: unexpected token`，夹具绿红必须连同车 sha 记录。

### 4.3 C 冷律对照

```sh
W=$(mktemp -d)
env CHENG_DISABLE_COLD_OBJECT_CACHE=1 CHENG_PROCESS_MAX_RSS_BYTES=2147483648 \
  TMPDIR="$W" LC_ALL=C \
  ./artifacts/bootstrap/cheng.stage3.bak.748113d1 system-link-exec \
  --in:"$PWD/src/tests/fixtures/function_task_simple.cheng" \
  --out:"$W/x.o" --emit:obj --root:"$PWD"
```

- 冷律二进制=canonical C 烤种 `artifacts/bootstrap/cheng.stage3.bak.748113d1`（sha `748113d1…`，bake 脚本先验它：`.c0run/r45/kernel/bake_snapshot.sh:10,14`）。
- 冷律 `--root:` 下，输入源必须位于 `<root>/src/` 之内（`bootstrap/cheng_cold.c:3224-3237` 只认该前缀）；否则 rc=2 `cheng_cold: cold source snapshot source path leaves package root`（实测）。
- `--emit:obj`，不是 `--emit:object`（合法值表：`bootstrap/cheng_cold.c:17416-17418`）。
- 判读：rc=0 且 `--out` 对象非空 = C 冷律接受（本次实测 3880B）；rc=2 + `cheng_cold:` 判词 = C 链拒绝（本次负例判词 `fixed array index assignment requires a mutable global`）。
- 现成脚本样式：`.c0run/scamp11/L3/cold.sh:10-11`（同一 argv 形）。

### 4.4 pe / ov 判词查法

- 诊断形：`error:<line>:<col>: <text>`（`kernel/parse/core0_cli.cheng:336-345`）。
- 文本→号：在 `pe_text` 表 grep 字面量（`kernel/parse/core0_cli.cheng:121` 起）。例：`grep -n '"immutable binding"' kernel/parse/core0_cli.cheng` → 185（`m == 21`）。
- 号→文本：`kernel/parse/parse.cheng:24-43` 的 pe 号表；常用 17=unsupported formal subset、20=explicit typed default、21=immutable binding、24=pointer type forbidden、25=pointer operation forbidden。
- 镜像文本表：`src/core0_stage/driver/selfhost_main.cheng:694` 的 `sh_pe_text`。
- ownership 判词形：`error:<l>:<c>: ownership violation ov<N> slot=<n>`（`kernel/driver/selfhost_main.cheng:1035-1047`）；ov 号表在 `kernel/semantic/ownership_dataflow.cheng:123-125`：1=use-before-alloc、2=use-after-region-retire、3=use-after-move、5=leak-at-exit、6=missing-return、7=overlapping-exclusive-borrow、8=borrow-escape；`100+kind`=collect 模式结构拒收（同文件:157-162）。
- 先取首判：`... 2>&1 | grep -m1 '^error:'`；别把后续连带错误当首墙。

## 5. 常见坑

1. **车绿 ≠ spec 合法，spec 合法 ≠ 车绿**：现槽对 `var x: int32 = 0` 实测 rc=0（§4.1 命令；spec:645 明令硬错）；反过来局部 `var xs: int32[]` 实测 pe17（§4.1 命令；spec:603 合法，`kernel/spec/INTERFACES.md:369` 记 fail-closed）。语言问题看 spec，验收看车；不拿车绿改语言结论，也不为车墙改写业务源（spec:263）。
2. **冷律 rc=2 ≠ 正确性差分**：C 烤种会按 SABI/ZRPC 在 ABI 面编红，车可能无该门编绿却链死；这是执法位置差（findings.md:80，168R 差分定级）。必须再看链接/运行/负例，不能拿单 rc 判真差。
3. **冷律只验 obj rc 不验可链性**：单 main 件 `@importc` 曾出双 `_main` malformed obj，obj rc 绿仍不可链（findings.md:43，166R COLD_MALFORMED_OBJ）。
4. **1503 是编译面**：不链接、不运行、不比对象字节（findings.md:1886），绿数不能当运行正确性。
5. **跨轮绿数不可直接相减**：树在并发演化；对账用同窗 A/B 卷（`.agents/skills/cheng-models/SKILL.md` §0.1；findings.md:1816/1833/1843 是不同窗口的读数）。
6. **census gap=0 ≠ 文本 realizer 可删**：文本路径可能认领语句但仍走文本 codegen；删文本必须同时满足 census gap=0 + 运行时与文本 golden 一致 + poison-on-miss（AGENTS.md §4b.4）。
7. **绝不 `git checkout -- <file>` / `git restore <file>` 撤回共享文件**：会连带丢弃并发会话未提交 WIP，且不可逆（AGENTS.md §4b.6）。逐行 Edit 还原，或 `git stash push -- <pathspec>`。
8. **改 `src/core/*` 进不了 stage3**：stage3 走 cold 闭包；用最小 repro + `CHENG_NODE_EVAL_ONLY=1` census 验证，别整编 130k 行（AGENTS.md §4b.3）。
9. **夹具期望 rc 绑定车 sha**：`src/tests/fixtures/README.md:18` 的绿是集成车 `2e458940` 的读数；现槽 `268d237c` 下 `src/tests/fixtures/gates/g168/c1.cheng` 实测 rc=1。每次记录车 sha + 首判，别跨车比较。
10. **源的位置合同**：车 obj 对含 import 的源要求包根内；冷律要求源在 `<root>/src/` 下。无 import 的单件可在 /tmp 编。临时件放仓库内任务目录并在收尾删除。

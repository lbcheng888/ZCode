// ============================================================
// Cheng spec 草案校验器（fail-closed）
// ============================================================
// 事实来源是真实夹具（cheng-lang data/spec_v2/tasks/p01_max2.spec.json、p06_fib.spec.json
// 与 data/spec_v2_dag3/tasks/c01_dag3_par.spec.json）：task 名是文件名段（[a-z0-9_]），
// 模块名可含点（p06 的 `ops.fadd` 是 fn 限定，不是嵌套层级），links[].type 只出现过
// implemented_by / verified_by / exercises / composes 四种。
//
// 校验失败必须把**全部**错误一次性报给模型（ChengGenerate 把它们拼进 400 文案），
// 而不是挤牙膏式一次一条；任何一条不过就不落盘、不开作业。

/** 夹具 links[].type 的实测全集；新增类型先补夹具再补这里。 */
const CHENG_SPEC_LINK_TYPES: ReadonlySet<string> = new Set([
  "implemented_by",
  "verified_by",
  "exercises",
  "composes",
]);

/**
 * task 名同时是落盘文件名段（`<task>-<uuid>.json`），只放行字母/数字/下划线/连字符。
 * `/`、`\`、`..`、空白与控制字符全被排除——路径穿越在字符面上就不可能，而不是靠
 * 落盘前再洗一遍。
 */
const CHENG_SPEC_TASK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type ChengSpecDraftVerdict =
  | { ok: true; task: string }
  | { ok: false; errors: string[] };

interface DeclaredModule {
  id: string;
  name: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(
  value: unknown,
  label: string,
  errors: string[],
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${label} 必须是非空字符串`);
    return undefined;
  }
  return value;
}

/**
 * 解析 link 端点指向的实体；命中模块时带回**归一后的 module id**。
 *
 * 模块走两条路：id 精确匹配，或按夹具 id 语法 `mod.<task>.<name>` 兜底——`name` 本身
 * 可含点（`mod.p06_fib.ops.fadd` 的 name 是 `ops.fadd`），所以绝不能按点 naive 切分，
 * 只能拿声明侧的完整 name 做字符串比对。requirement/assertion 只按声明的 id 精确匹配
 * （夹具的这两个 id 不承载可推导语法）。
 *
 * 返回命中模块的 id 是环检测的正确性前提：composes 图以 module id 建键，若边存原始
 * ref（惯用形 `mod.<task>.<name>`），`mod.t.x → mod.t.y` 互指的环会游离在键集之外，
 * 拓扑排序看不见——所以边必须在解析点归一成 id，绝不能沿用模型写的原文。
 */
type LinkEndpointResolution =
  | { kind: "requirement" }
  | { kind: "assertion" }
  /** 命中模块时携带声明侧 id（两种引用形式坍缩到同一权威键）。 */
  | { kind: "module"; moduleId: string };

function resolveLinkEndpoint(
  ref: string,
  task: string,
  modules: readonly DeclaredModule[],
  requirementIds: ReadonlySet<string>,
  assertionIds: ReadonlySet<string>,
): LinkEndpointResolution | undefined {
  if (requirementIds.has(ref)) return { kind: "requirement" };
  if (assertionIds.has(ref)) return { kind: "assertion" };
  const byId = modules.find((module) => module.id === ref);
  if (byId !== undefined) return { kind: "module", moduleId: byId.id };
  const byFixtureIdiom = modules.find(
    (module) => ref === `mod.${task}.${module.name}`,
  );
  return byFixtureIdiom === undefined
    ? undefined
    : { kind: "module", moduleId: byFixtureIdiom.id };
}

/**
 * 在 composes 边构成的模块有向图里找一个具体的环（Kahn 判定环存在后，用它产出
 * 「a → b → a」文案）。三色 DFS：灰到灰即成环，栈切片就是路径。
 */
function findComposesCycle(
  adjacency: ReadonlyMap<string, readonly string[]>,
): string[] | undefined {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const visit = (node: string): string[] | undefined => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const nextColor = color.get(next) ?? WHITE;
      if (nextColor === GRAY) {
        return [...stack.slice(stack.indexOf(next)), next];
      }
      if (nextColor === WHITE) {
        const found = visit(next);
        if (found !== undefined) return found;
      }
    }
    color.set(node, BLACK);
    stack.pop();
    return undefined;
  };
  for (const node of adjacency.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      const found = visit(node);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function validateChengSpecDraft(draft: unknown): ChengSpecDraftVerdict {
  const errors: string[] = [];

  if (!isPlainObject(draft)) {
    return {
      ok: false,
      errors: [`spec 草案必须是 JSON 对象，收到 ${typeof draft}`],
    };
  }

  // ---- task：非空 + 字符安全（它要进文件名）----
  const task = requireNonEmptyString(draft.task, "task", errors);
  if (task !== undefined && !CHENG_SPEC_TASK_NAME_PATTERN.test(task)) {
    errors.push(
      `task 名 "${task}" 字符不安全：只允许字母/数字/下划线/连字符（路径分隔符与 ".." 一律拒绝，杜绝路径穿越）`,
    );
  }

  // ---- requirements：不强制在场，但一旦在场就按夹具形状收 id（供 link 解析）----
  const requirementIds = new Set<string>();
  const requirementsRaw = draft.requirements;
  if (requirementsRaw !== undefined) {
    if (!Array.isArray(requirementsRaw)) {
      errors.push("requirements 在场时必须是数组");
    } else {
      requirementsRaw.forEach((requirement: unknown, index: number) => {
        if (!isPlainObject(requirement)) {
          errors.push(`requirements[${index}] 必须是对象`);
          return;
        }
        const id = requireNonEmptyString(requirement.id, `requirements[${index}].id`, errors);
        if (id !== undefined) {
          if (requirementIds.has(id)) errors.push(`requirements 里存在重复 id "${id}"`);
          else requirementIds.add(id);
        }
      });
    }
  }

  // ---- modules：非空、名字唯一（id 供 link 解析，同样要求唯一）----
  const modules: DeclaredModule[] = [];
  const modulesRaw = draft.modules;
  const modulesShapeOk = Array.isArray(modulesRaw);
  if (!modulesShapeOk) {
    errors.push("modules 必须是数组");
  } else if (modulesRaw.length === 0) {
    errors.push("modules 不能为空：草案至少要声明一个模块");
  } else {
    const seenNames = new Set<string>();
    const seenIds = new Set<string>();
    modulesRaw.forEach((module: unknown, index: number) => {
      if (!isPlainObject(module)) {
        errors.push(`modules[${index}] 必须是对象`);
        return;
      }
      const name = requireNonEmptyString(module.name, `modules[${index}].name`, errors);
      const id = requireNonEmptyString(module.id, `modules[${index}].id`, errors);
      if (name !== undefined) {
        if (seenNames.has(name)) {
          errors.push(`modules 里存在重名模块 "${name}"（modules[${index}] 与先前的声明冲突）`);
        } else {
          seenNames.add(name);
        }
      }
      if (id !== undefined) {
        if (seenIds.has(id)) errors.push(`modules 里存在重复 id "${id}"`);
        else seenIds.add(id);
      }
      if (name !== undefined && id !== undefined) modules.push({ id, name });
    });
  }

  // ---- assertions：非空（id 供 link 解析）----
  const assertionIds = new Set<string>();
  const assertionsRaw = draft.assertions;
  const assertionsShapeOk = Array.isArray(assertionsRaw);
  if (!assertionsShapeOk) {
    errors.push("assertions 必须是数组");
  } else if (assertionsRaw.length === 0) {
    errors.push("assertions 不能为空：没有断言的草案无从验收");
  } else {
    assertionsRaw.forEach((assertion: unknown, index: number) => {
      if (!isPlainObject(assertion)) {
        errors.push(`assertions[${index}] 必须是对象`);
        return;
      }
      const id = requireNonEmptyString(assertion.id, `assertions[${index}].id`, errors);
      if (id !== undefined) {
        if (assertionIds.has(id)) errors.push(`assertions 里存在重复 id "${id}"`);
        else assertionIds.add(id);
      }
    });
  }

  // ---- links：形状、type 枚举、端点必须指向已声明实体；composes 两端必须是模块 ----
  // modules 形状坏掉时无从解析端点，跳过这层检查（形状错误已在上报），让文案聚焦。
  const linksRaw = draft.links;
  const linksShapeOk = Array.isArray(linksRaw);
  if (!linksShapeOk) {
    errors.push("links 必须是数组");
  } else if (modulesShapeOk) {
    const composesEdges: { from: string; to: string }[] = [];
    linksRaw.forEach((link: unknown, index: number) => {
      if (!isPlainObject(link)) {
        errors.push(`links[${index}] 必须是对象`);
        return;
      }
      const from = requireNonEmptyString(link.from, `links[${index}].from`, errors);
      const to = requireNonEmptyString(link.to, `links[${index}].to`, errors);
      const type = requireNonEmptyString(link.type, `links[${index}].type`, errors);
      if (type !== undefined && !CHENG_SPEC_LINK_TYPES.has(type)) {
        errors.push(
          `links[${index}].type "${type}" 不在夹具枚举内（合法值: ${[...CHENG_SPEC_LINK_TYPES].join(" | ")}）`,
        );
      }
      if (task === undefined || from === undefined || to === undefined) return;
      const fromEndpoint = resolveLinkEndpoint(from, task, modules, requirementIds, assertionIds);
      const toEndpoint = resolveLinkEndpoint(to, task, modules, requirementIds, assertionIds);
      if (fromEndpoint === undefined) {
        errors.push(`links[${index}].from "${from}" 未指向已声明的 requirement/module/assertion`);
      }
      if (toEndpoint === undefined) {
        errors.push(`links[${index}].to "${to}" 未指向已声明的 requirement/module/assertion`);
      }
      if (type === "composes") {
        if (fromEndpoint?.kind !== "module") {
          errors.push(`links[${index}] composes 边的 from "${from}" 必须是已声明模块`);
        }
        if (toEndpoint?.kind !== "module") {
          errors.push(`links[${index}] composes 边的 to "${to}" 必须是已声明模块`);
        }
        if (fromEndpoint?.kind === "module" && toEndpoint?.kind === "module") {
          // 边存归一后的 module id：惯用形/混合形引用与 id 形在同一张图里判环。
          composesEdges.push({ from: fromEndpoint.moduleId, to: toEndpoint.moduleId });
        }
      }
    });

    // ---- composes DAG：拓扑排序判定，环要报出具体路径 ----
    const moduleIds = new Set(modules.map((module) => module.id));
    const adjacency = new Map<string, string[]>();
    const indegree = new Map<string, number>();
    for (const id of moduleIds) {
      adjacency.set(id, []);
      indegree.set(id, 0);
    }
    for (const edge of composesEdges) {
      adjacency.get(edge.from)?.push(edge.to);
      indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    }
    const ready = [...moduleIds].filter((id) => (indegree.get(id) ?? 0) === 0);
    let processed = 0;
    while (ready.length > 0) {
      const node = ready.pop()!;
      processed += 1;
      for (const next of adjacency.get(node) ?? []) {
        const nextIndegree = (indegree.get(next) ?? 0) - 1;
        indegree.set(next, nextIndegree);
        if (nextIndegree === 0) ready.push(next);
      }
    }
    if (processed < moduleIds.size) {
      const cycle = findComposesCycle(adjacency);
      errors.push(
        cycle === undefined
          ? "composes 边构成环：模块依赖图拓扑排序失败"
          : `composes 边构成环: ${cycle.join(" → ")}；环上的模块永远无法按依赖序生成`,
      );
    }
  }

  if (task === undefined || errors.length > 0) return { ok: false, errors };
  return { ok: true, task };
}

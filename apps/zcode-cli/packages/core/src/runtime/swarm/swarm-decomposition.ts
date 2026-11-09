/**
 * 蜂群目标分解响应的解析。
 *
 * 先处理 finishReason=length 的截断，再剥 ```json 围栏；截断响应无论如何都不
 * 解析——半份任务清单不能开工；围栏外的前后散文允许存在。
 */

export const SWARM_MIN_TASKS = 2;
export const SWARM_MAX_TASKS = 5;

/**
 * 分解调用的系统提示：只产出 JSON 任务清单，不提问、不加评论。
 * 断点续跑时只剩 1 个未完成任务是合法结果，因此下限随轮次调整；初始轮仍 ≥ 2。
 */
export function createSwarmDecompositionSystemPrompt(
  minTasks: number = SWARM_MIN_TASKS,
): string {
  return `You are decomposing a goal into parallel subtasks for a swarm of workers.
Return between ${minTasks} and ${SWARM_MAX_TASKS} subtasks that can be executed independently and in parallel.
- Each subtask must be self-contained; another worker can complete it without the other subtasks' results.
- Cover the whole goal; do not leave work for a later merge unless it is itself one of the subtasks.
- Do not ask questions or add commentary; return only the JSON object.`;
}

/**
 * 分解响应 schema：tasks[].description 是唯一字段，结构不符由解析层响亮失败。
 * minTasks 只允许断点续跑降为 1；schema 与 parse 必须用同一个下限。
 */
export function createSwarmDecompositionResponseSchema(
  minTasks: number = SWARM_MIN_TASKS,
) {
  return {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        minItems: minTasks,
        maxItems: SWARM_MAX_TASKS,
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
          },
          required: ["description"],
          additionalProperties: false,
        },
      },
    },
    required: ["tasks"],
    additionalProperties: false,
  };
}

/**
 * 解析分解响应：先处理 finishReason=length 的截断，再剥 ```json 围栏。
 * 截断响应无论如何都不解析——半份任务清单不能开工；围栏外的前后散文允许存在。
 */
export function parseDecompositionResponse(
  text: string,
  finishReason?: string,
  minTasks: number = SWARM_MIN_TASKS,
): string[] {
  if (finishReason === "length") {
    throw new Error(
      "Swarm decomposition response was truncated (finishReason=length); refusing to execute a partial task list",
    );
  }
  const jsonText = extractJsonPayload(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`Swarm decomposition response is not valid JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.tasks)) {
    throw new Error("Swarm decomposition response must be an object with a tasks array");
  }
  if (parsed.tasks.length < minTasks || parsed.tasks.length > SWARM_MAX_TASKS) {
    throw new Error(
      `Swarm decomposition must produce ${minTasks}-${SWARM_MAX_TASKS} tasks, received ${parsed.tasks.length}`,
    );
  }
  return parsed.tasks.map((task, index) => {
    if (!isRecord(task) || typeof task.description !== "string") {
      throw new Error(`Swarm decomposition task at index ${index} has no string description`);
    }
    const description = task.description.trim();
    if (!description) {
      throw new Error(`Swarm decomposition task at index ${index} has an empty description`);
    }
    return description;
  });
}

/** 从裸 JSON 或 ```json 围栏中取出 JSON 对象文本；找不到时响亮失败。 */
function extractJsonPayload(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Swarm decomposition response is empty");
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("Swarm decomposition response contains no JSON object");
  }
  return candidate.slice(start, end + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


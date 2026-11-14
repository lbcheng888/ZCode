import { describe, expect, it } from "vitest";
import {
  createSessionId,
  type Model,
  type ModelOptions,
  type ModelRequest,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFormatProperties } from "./test-runtime-model.js";

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["goal", "steps"],
  properties: {
    goal: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
  },
};

function createCapturingModel(requests: ModelRequest[], binds?: ModelOptions[]): Model {
  const model: Model = {
    providerId: "test-provider",
    modelId: "glm-test",
    properties: {
      contextWindow: 128_000,
      ...createTestModelFormatProperties(),
      supportsMidConversationSystem: false,
      supportsNativeWebSearch: false,
      supportsJsonSchemaOutput: true,
      supportsToolCall: true,
    },
    optionSpecs: {
      reasoningLevel: { values: ["disabled"] },
      maxOutputTokens: { max: 128_000 },
    },
    options: {
      maxOutputTokens: 128_000,
      reasoningLevel: "disabled",
    },
    bind(options) {
      binds?.push(options);
      return this;
    },
    async generateText(request: ModelRequest) {
      requests.push(request);
      return {
        text: "{}",
        finishReason: "stop",
        usage: { totalTokens: 1 },
      };
    },
    async *streamText(request: ModelRequest) {
      // generateWorkspaceText 当前走 generateText；streamText 同样记录，入口切换时仍可观察到请求。
      requests.push(request);
      yield { type: "finish" as const, finishReason: "stop" };
    },
  } as unknown as Model;
  return model;
}

function createRuntimeWithModel(model: Model) {
  return createTestAgentRuntime(
    createSessionId("workspace-generate-text-response-schema"),
    {
      taskType: "interactive",
      modelSelection: createTestModelSelection("test-provider/glm-test", {}),
    },
    {
      eventStore: createTestSessionEventStore(),
      modelFactory: () => model,
    },
  );
}

describe("workspace generateText responseJsonSchema", () => {
  it("passes responseJsonSchema through to the ModelRequest verbatim", async () => {
    const requests: ModelRequest[] = [];
    const runtime = createRuntimeWithModel(createCapturingModel(requests));

    await runtime.generateWorkspaceText({
      selection: { providerId: "test-provider", modelId: "glm-test" },
      prompt: "Generate a six-field plan",
      querySource: "workspace_generate_text",
      responseJsonSchema: RESPONSE_SCHEMA,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.responseJsonSchema).toBe(RESPONSE_SCHEMA);
    expect(Object.keys(requests[0]!)).toContain("responseJsonSchema");
  });

  it("omits responseJsonSchema when the caller does not provide it", async () => {
    const requests: ModelRequest[] = [];
    const runtime = createRuntimeWithModel(createCapturingModel(requests));

    await runtime.generateWorkspaceText({
      selection: { providerId: "test-provider", modelId: "glm-test" },
      prompt: "Generate a six-field plan",
      querySource: "workspace_generate_text",
    });

    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!)).not.toContain("responseJsonSchema");
    expect(requests[0]).not.toHaveProperty("responseJsonSchema");
  });

  it("binds auxiliary options for the best_plan_super_agent query source", async () => {
    const requests: ModelRequest[] = [];
    const binds: ModelOptions[] = [];
    const runtime = createRuntimeWithModel(createCapturingModel(requests, binds));

    await runtime.generateWorkspaceText({
      selection: { providerId: "test-provider", modelId: "glm-test" },
      prompt: "Generate a six-field plan",
      querySource: "best_plan_super_agent",
      maxOutputTokens: 2_048,
      responseJsonSchema: RESPONSE_SCHEMA,
    });

    // 方案卡是格式化任务：与 git_commit_message / input_prediction 同走辅助档，
    // 绑定最低公开档位 + 辅助输出预算，砍掉 reasoning token 放大。
    expect(binds).toEqual([{ reasoningLevel: "disabled", maxOutputTokens: 5_000 }]);
    // 绑定不改变请求行为：结构化 schema 与调用方预算仍原样传递。
    expect(requests).toHaveLength(1);
    expect(requests[0]!.responseJsonSchema).toBe(RESPONSE_SCHEMA);
    expect(requests[0]!.options).toEqual({ maxOutputTokens: 2_048 });
  });
});

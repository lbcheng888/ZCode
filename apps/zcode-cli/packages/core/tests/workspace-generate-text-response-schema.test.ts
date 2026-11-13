import { describe, expect, it } from "vitest";
import { createSessionId, type Model, type ModelRequest } from "@zcode/contracts";
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

function createCapturingModel(requests: ModelRequest[]): Model {
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
    bind(_options) {
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
});

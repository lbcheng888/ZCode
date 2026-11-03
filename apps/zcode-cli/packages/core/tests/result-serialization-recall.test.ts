import { describe, expect, it } from "vitest";
import type {
  ToolArtifactReadRequest,
  ToolArtifactStorePort,
  ToolArtifactWriteRequest,
} from "@zcode/contracts";
import { recallArtifactIdFromUri } from "@zcode/contracts";
import { serializeOutput } from "../src/tool/executor/result-serialization.js";
import type { ToolExecutorDeps } from "../src/tool/executor/types.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";

// M9：溢写产物 URI 必须是 recall 可解析 ID——envelope 里给模型一条 Recall 指引，
// 路径给 Read、ID 给 Recall，两条取回路径并存。

const SESSION_ID = "sess_serial_recall" as ToolExecutorDeps["sessionId"];

function minimalToolExecutorDeps(): ToolExecutorDeps {
  return {
    defaultTimeoutMs: 300_000,
    emitEvent: async () => {},
    getMode: () => "build",
    getWorkingDirectory: () => "/tmp",
    getWorkspaceRoot: () => "/tmp",
    maxConcurrency: 1,
    permissionBroker: {} as ToolExecutorDeps["permissionBroker"],
    permissionService: {} as ToolExecutorDeps["permissionService"],
    readFileState: new Map(),
    registry: {} as ToolExecutorDeps["registry"],
    sessionId: SESSION_ID,
  };
}

class SessionScopedArtifactStore implements ToolArtifactStorePort {
  async writeToolResultArtifact(request: ToolArtifactWriteRequest) {
    return {
      id: "art_recall_1",
      uri: `zcode-artifact://${encodeURIComponent(String(request.sessionId))}/art_recall_1`,
      path: "/artifacts/art_recall_1.txt",
      bytes: Buffer.byteLength(request.content, "utf8"),
      contentType: request.contentType ?? "text/plain",
      createdAt: new Date(),
    };
  }

  async readToolResultArtifact(_request: ToolArtifactReadRequest): Promise<never> {
    throw new Error("readToolResultArtifact should not be called");
  }
}

describe("result serialization recall interplay", () => {
  it("surfaces a recall-resolvable id when a large tool result spills to an artifact", async () => {
    const stdout = "x".repeat(30_001);
    const result = await serializeOutput(
      { ...minimalToolExecutorDeps(), artifactStore: new SessionScopedArtifactStore() },
      { stdout, stderr: "", interrupted: false, status: "completed" },
      bashToolEntry,
      {},
      "tool_bash_recall",
      new AbortController().signal,
    );

    expect(result.content).toContain("<persisted-output>");
    expect(result.content).toContain(
      `Recall the full output later with Recall: ids=["artifact:${String(SESSION_ID)}/art_recall_1"].`,
    );
    // 指引里的 ID 与 URI 是同一资源（双向可解）。
    expect(
      recallArtifactIdFromUri(`zcode-artifact://${String(SESSION_ID)}/art_recall_1`),
    ).toBe(`${String(SESSION_ID)}/art_recall_1`);
  });

  it("leaves the envelope untouched when the artifact URI is not recall-shaped", async () => {
    const stdout = "y".repeat(30_001);
    const legacyStore: ToolArtifactStorePort = {
      async writeToolResultArtifact(request: ToolArtifactWriteRequest) {
        return {
          id: "artifact-1",
          // 旧 URI 形态（非 sess_*）：不能解析成召回 ID，也不给模型假指引。
          uri: "zcode-artifact://test/artifact-1",
          path: "/artifacts/artifact-1.json",
          bytes: Buffer.byteLength(request.content, "utf8"),
          contentType: request.contentType ?? "text/plain",
          createdAt: new Date(),
        };
      },
      async readToolResultArtifact(): Promise<never> {
        throw new Error("not used");
      },
    };

    const result = await serializeOutput(
      { ...minimalToolExecutorDeps(), artifactStore: legacyStore },
      { stdout, stderr: "", interrupted: false, status: "completed" },
      bashToolEntry,
      {},
      "tool_bash_legacy",
      new AbortController().signal,
    );

    expect(result.content).toContain("Full output saved to: /artifacts/artifact-1.json");
    expect(result.content).not.toContain("Recall the full output later");
  });
});

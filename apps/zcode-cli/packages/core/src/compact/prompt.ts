import {
  compactRecoveryPointerSchema,
  type CompactRecoveryPointer,
} from "@zcode/contracts";

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

const NO_TOOLS_TRAILER =
  "\n\nREMINDER: Do NOT call any tools. Respond with plain text only — " +
  "an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.";

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
   - Note any security-relevant instructions or constraints the user stated (e.g., sensitive files or data to avoid, operations that must not be performed, credential or secret handling rules). These MUST be preserved verbatim in the summary so they continue to apply after compaction.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent. Preserve any security-relevant instructions or constraints verbatim so they remain in effect after compaction.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.
10. Recovery Pointer (REQUIRED): End your <summary> with a machine-readable block on its own lines, exactly in this form:

<recovery_pointer>
{"objective":"<1-2 sentences: the user's primary objective>","criterion":"<how completion will be judged, verifiable outcomes>","fileMap":["<paths most critical to continuing the work>"],"openQuestions":["<unresolved questions blocking progress>"],"recallSeedIds":["<stable resource ids you actually saw in this conversation>"]}
</recovery_pointer>

   - objective / criterion are plain strings; fileMap / openQuestions / recallSeedIds are JSON arrays (use [] when empty).
   - recallSeedIds must be ids you really saw (forms like target:..., wf-run:..., session:..., artifact:...). Never invent ids; use [] if you saw none.
   - The runtime reads this block after compaction to restore the anchor. Do not wrap it in markdown code fences.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:${" "}
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.${" "}

There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions when creating the above summary. Examples of instructions include:
<example>
## Compact Instructions
When summarizing the conversation focus on typescript code changes and also remember the mistakes you made and how you fixed them.
</example>

<example>
# Summary instructions
When you are using compact - please focus on test output and code changes. Include file reads verbatim.
</example>`;

export function buildCompactPrompt(customInstructions: string | undefined): string {
  const customInstructionBlock = customInstructions?.trim()
    ? `\n\nAdditional Instructions:\n${customInstructions}`
    : "";

  return `${NO_TOOLS_PREAMBLE}${BASE_COMPACT_PROMPT}${customInstructionBlock}${NO_TOOLS_TRAILER}`;
}

export function formatCompactSummary(text: string | undefined): string {
  let formatted = text?.trim() ?? "";
  if (!formatted) return "";

  formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/, "");
  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    const summary = summaryMatch[1] || "";
    formatted = formatted.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${summary.trim()}`);
  }

  return formatted.replace(/\n\n+/g, "\n\n").trim();
}

export function buildCompactSummaryMessage(
  summary: string,
  options: {
    recentMessagesPreserved?: boolean;
    replStateCleared?: boolean;
    suppressFollowup?: boolean;
    transcriptPath?: string;
  } = {},
): string {
  let message = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${formatCompactSummary(summary)}`;

  if (options.transcriptPath) {
    message += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${options.transcriptPath}`;
  }

  if (options.recentMessagesPreserved) {
    message += "\n\nRecent messages are preserved verbatim.";
  }

  if (options.replStateCleared) {
    message +=
      "\n\nYour REPL VM state has been cleared as part of this compaction. Variables defined in REPL calls before this point are no longer accessible — redefine any you still need.";
  }

  if (options.suppressFollowup) {
    message +=
      '\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.';
  }

  return message;
}

const RECOVERY_POINTER_BLOCK_PATTERN =
  /<recovery_pointer>\s*([\s\S]*?)\s*<\/recovery_pointer>/i;

export interface ExtractCompactRecoveryPointerResult {
  /** 剥离指针块之后的原文（喂给 formatCompactSummary 的输入）。 */
  text: string;
  pointer?: CompactRecoveryPointer;
  /** 块在场但 JSON/schema 非法时的诊断片段——调用方落 warn，不失败 compact。 */
  invalid?: string;
}

/**
 * 从 compact 模型原文剥离 <recovery_pointer> 块并解析（M9）。
 * 宽进：块缺失 → 无指针；块在场但 JSON/schema 非法 → invalid 诊断 + 无指针。
 * 决策记录见 docs/architecture/super-agent-context-recall-spec.md §7：
 * compact 失败在 context-exceeded 场景会楔死会话，指针是增强不是 compact 的核心契约。
 */
export function extractCompactRecoveryPointer(rawText: string): ExtractCompactRecoveryPointerResult {
  const match = RECOVERY_POINTER_BLOCK_PATTERN.exec(rawText);
  if (!match) return { text: rawText };

  const raw = match[1].trim();
  const text = rawText.replace(RECOVERY_POINTER_BLOCK_PATTERN, "").trim();
  try {
    const parsed = compactRecoveryPointerSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { text, pointer: parsed.data };
    return { text, invalid: parsed.error.issues.map((issue) => issue.message).join("; ") };
  } catch (error) {
    return { text, invalid: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 重挂 anchor 时给模型的固定投影。compact 后的 post-compact reminder 与 resume 冷恢复
 * 的 attachment 共用这一个实现——两处措辞分叉会让模型以为是两份不同的上下文。
 */
export function formatCompactRecoveryPointerForModel(pointer: CompactRecoveryPointer): string {
  const lines = [
    "Recovery anchor (restored after compaction; authoritative continuation context):",
    "Objective:",
    `<recovery_objective>${pointer.objective}</recovery_objective>`,
    "Completion criterion:",
    `<recovery_criterion>${pointer.criterion}</recovery_criterion>`,
  ];
  if (pointer.fileMap.length > 0) {
    lines.push("Critical files:", ...pointer.fileMap.map((entry) => `- ${entry}`));
  }
  if (pointer.openQuestions.length > 0) {
    lines.push("Open questions:", ...pointer.openQuestions.map((entry) => `- ${entry}`));
  }
  if (pointer.recallSeedIds.length > 0) {
    lines.push(
      "Recall seed ids (full resources are outside the context window; call Recall with these ids to reload them):",
      ...pointer.recallSeedIds.map((entry) => `- ${entry}`),
    );
  }
  return lines.join("\n");
}

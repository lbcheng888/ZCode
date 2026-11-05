// P6 设备矩阵的 workspace 边界（spec §1.3「纯读 allow（限 workspace）」/ D7）。
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PermissionContext } from "./service.js";

/** 读类工具会解析进文件系统的输入字段（Read: file_path；Glob/Grep: path）。 */
const READ_PATH_INPUT_FIELDS = ["file_path", "path"] as const;

/**
 * 非 host 角色的纯读是否越出 workspace。
 *
 * 这里用词法包含判定：resolve 后 relative 必须不以 `..` 开头、不是另一个盘符。
 * 无法拿到 workingDirectory 时 fail-closed（不能证明在 workspace 内就拒绝）。
 * 符号链接逃逸属于路径解析层（非本矩阵层）的问题，不在此处伪造“已覆盖”。
 */
export function readEscapesWorkspace(context: PermissionContext): boolean {
  if (typeof context.input !== "object" || context.input === null) return false;
  const input = context.input as Record<string, unknown>;
  for (const field of READ_PATH_INPUT_FIELDS) {
    const value = input[field];
    if (typeof value !== "string" || value.length === 0) continue;
    if (context.workingDirectory === undefined) return true;
    const resolvedPath = isAbsolute(value)
      ? resolve(value)
      : resolve(context.workingDirectory, value);
    const relativePath = relative(context.workingDirectory, resolvedPath);
    if (relativePath === "") continue;
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      return true;
    }
  }
  return false;
}

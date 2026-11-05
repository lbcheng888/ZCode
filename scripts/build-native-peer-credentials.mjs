#!/usr/bin/env node
/**
 * 构建 `packages/native-peer-credentials` 的 Node-API addon（milestone-b-spec §3.8）。
 *
 * 产物：`packages/native-peer-credentials/prebuilds/<platform>-<arch>/peercred.node`
 * （二进制不入库，源码与 binding.gyp 入库）。
 *
 * macOS/Linux 直接用本机 C 编译器 + 当前运行 Node 的头文件（不需要下载 node-gyp
 * headers）；Windows 走 node-gyp（需要 MSVC/Python）。不支持的平台或编译失败一律
 * 响亮失败，绝不静默跳过生成一个假产物。
 */
import { existsSync, mkdirSync, copyFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const packageDir = join(repoRoot, "packages", "native-peer-credentials");
const sourceFile = join(packageDir, "src", "peercred.c");

function readOption(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function resolveTarget() {
  const platform = readOption("platform") ?? process.platform;
  const arch = readOption("arch") ?? process.arch;
  if (!["darwin", "linux", "win32"].includes(platform)) {
    throw new Error(`unsupported peer credentials platform: ${platform}`);
  }
  if (platform !== process.platform) {
    throw new Error(
      `native peer credentials must be built on the target platform (host=${process.platform}, target=${platform})`,
    );
  }
  if (!["x64", "arm64"].includes(arch)) {
    throw new Error(`unsupported peer credentials arch: ${arch}`);
  }
  if (arch !== process.arch) {
    throw new Error(
      `native peer credentials must be built for the host arch (host=${process.arch}, target=${arch})`,
    );
  }
  return { platform, arch };
}

function nodeExecutable() {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

function findNodeIncludeDir() {
  const candidates = [];
  const configured = process.env.ZCODE_NODE_INCLUDE_DIR;
  if (configured) candidates.push(configured);
  const execPath = nodeExecutable();
  candidates.push(join(dirname(dirname(execPath)), "include", "node"));
  candidates.push(join(homedir(), ".cache", "node-gyp", process.versions.node, "include", "node"));
  candidates.push(join(homedir(), ".node-gyp", process.versions.node, "include", "node"));
  for (const candidate of candidates) {
    if (
      existsSync(join(candidate, "node_api.h")) &&
      existsSync(join(candidate, "js_native_api.h"))
    ) {
      return candidate;
    }
  }
  return undefined;
}

function run(command, args, options = {}) {
  console.log(`==> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", cwd: options.cwd ?? repoRoot });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "signal"}`);
  }
}

function outputPath(target, outputDir) {
  if (outputDir) return resolve(outputDir, "peercred.node");
  return join(packageDir, "prebuilds", `${target.platform}-${target.arch}`, "peercred.node");
}

function buildWithCompiler(target, includeDir, destination) {
  const compiler = process.env.CC?.trim() || "cc";
  const commonArgs = ["-DNAPI_VERSION=8", "-I", includeDir, "-O2", sourceFile, "-o", destination];
  const args =
    target.platform === "darwin"
      ? ["-bundle", "-undefined", "dynamic_lookup", "-fPIC", ...commonArgs]
      : ["-shared", "-fPIC", ...commonArgs];
  mkdirSync(dirname(destination), { recursive: true });
  run(compiler, args, { cwd: packageDir });
}

function buildWithNodeGyp(target, destination) {
  const nodeGyp = join(repoRoot, "node_modules", "node-gyp", "bin", "node-gyp.js");
  if (!existsSync(nodeGyp)) {
    throw new Error(
      `cannot build peer credentials for ${target.platform}: no Node headers found and node-gyp is not installed (${nodeGyp})`,
    );
  }
  run(process.execPath, [nodeGyp, "rebuild", "--directory", packageDir], { cwd: packageDir });
  const built = join(packageDir, "build", "Release", "peercred.node");
  if (!existsSync(built)) {
    throw new Error(`node-gyp finished without producing ${built}`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(built, destination);
}

function main() {
  const target = resolveTarget();
  if (!existsSync(sourceFile)) throw new Error(`missing addon source: ${sourceFile}`);
  const destination = outputPath(target, readOption("output-dir"));

  if (target.platform === "win32") {
    buildWithNodeGyp(target, destination);
  } else {
    const includeDir = findNodeIncludeDir();
    if (includeDir) {
      buildWithCompiler(target, includeDir, destination);
    } else {
      // 没有本机 Node 头文件时退到 node-gyp；这仍会真实编译，失败即响亮退出。
      buildWithNodeGyp(target, destination);
    }
  }

  console.log(`==> built ${destination}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

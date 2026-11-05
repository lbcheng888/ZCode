/**
 * super-agent control-plane RPC 的内核级 peer 身份（milestone-b-spec §3.8）。
 *
 * 导出唯一方法 `getPeerCredentials(fd)`：
 * - Linux: `getsockopt(SOL_SOCKET, SO_PEERCRED)` → `{ pid, uid, gid }`。
 * - macOS: `getsockopt(SOL_LOCAL, LOCAL_PEERPID)` + `getpeereid()` → `{ pid, uid, gid }`。
 * - Windows: **运行时不可用**。Node 公共 API 不把 named-pipe 连接句柄暴露为 fd，JS
 *   侧拿不到内核 HANDLE，`GetNamedPipeClientProcessId` 永远不会被真实调用；客户端 SID
 *   查询也未实现。调用方必须把 Windows 视为 unavailable（fail-closed），不得声称已支持。
 *
 * 任何无法取得身份的情况返回 JS `null`（调用方 fail-closed），绝不返回伪造的 PID。
 *
 * 注意：`_GNU_SOURCE` 必须在任何 libc 头文件之前定义。`node_api.h` 会经
 * `js_native_api_types.h` 拉入 `<stdint.h>` → glibc `<features.h>`，一旦那一刻
 * `_GNU_SOURCE` 还未定义，`struct ucred` / `SO_PEERCRED` 的声明就永远不会出现，
 * Linux 编译会因类型不完整而失败。
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <node_api.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#if defined(__APPLE__)
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>
#elif defined(__linux__)
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#elif defined(_WIN32)
#ifndef _WIN32_WINNT
/* GetNamedPipeClientProcessId 从 Windows 8 / Server 2012 起可用。 */
#define _WIN32_WINNT 0x0602
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

static napi_value return_null(napi_env env) {
  napi_value value;
  napi_get_null(env, &value);
  return value;
}

static void set_int64(napi_env env, napi_value object, const char *name, int64_t value) {
  napi_value number;
  if (napi_create_int64(env, value, &number) == napi_ok) {
    napi_set_named_property(env, object, name, number);
  }
}

static napi_value get_peer_credentials(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_value self;
  void *data;
  if (napi_get_cb_info(env, info, &argc, argv, &self, &data) != napi_ok || argc < 1) {
    return return_null(env);
  }
  napi_valuetype type;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_number) {
    return return_null(env);
  }
  int64_t raw = 0;
  if (napi_get_value_int64(env, argv[0], &raw) != napi_ok) {
    return return_null(env);
  }

  int64_t pid = 0;
  int64_t uid = 0;
  int64_t gid = 0;
  bool has_uid = false;
  bool has_gid = false;

#if defined(__linux__)
  int fd = (int)raw;
  if (fd < 0) {
    return return_null(env);
  }
  struct ucred credentials;
  int length = (int)sizeof(credentials);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &length) != 0 ||
      length < (int)sizeof(credentials)) {
    return return_null(env);
  }
  pid = (int64_t)credentials.pid;
  uid = (int64_t)credentials.uid;
  gid = (int64_t)credentials.gid;
  has_uid = true;
  has_gid = true;
#elif defined(__APPLE__)
  int fd = (int)raw;
  if (fd < 0) {
    return return_null(env);
  }
  pid_t peer_pid = 0;
  socklen_t length = (socklen_t)sizeof(peer_pid);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &peer_pid, &length) != 0 ||
      length < (socklen_t)sizeof(peer_pid)) {
    return return_null(env);
  }
  pid = (int64_t)peer_pid;
  uid_t peer_uid = 0;
  gid_t peer_gid = 0;
  if (getpeereid(fd, &peer_uid, &peer_gid) == 0) {
    uid = (int64_t)peer_uid;
    gid = (int64_t)peer_gid;
    has_uid = true;
    has_gid = true;
  }
#elif defined(_WIN32)
  // Node 不把 named-pipe 连接句柄暴露为 fd；调用方若拿到内核 HANDLE，可以按整数传入。
  HANDLE handle = (HANDLE)(uintptr_t)raw;
  if (handle == NULL) {
    return return_null(env);
  }
  DWORD client_pid = 0;
  if (!GetNamedPipeClientProcessId(handle, &client_pid)) {
    return return_null(env);
  }
  pid = (int64_t)client_pid;
#else
  return return_null(env);
#endif

  if (pid <= 0) {
    return return_null(env);
  }
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok) {
    return return_null(env);
  }
  set_int64(env, result, "pid", pid);
  if (has_uid) {
    set_int64(env, result, "uid", uid);
  }
  if (has_gid) {
    set_int64(env, result, "gid", gid);
  }
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value fn;
  if (napi_create_function(
          env, "getPeerCredentials", NAPI_AUTO_LENGTH, get_peer_credentials, NULL, &fn) ==
      napi_ok) {
    napi_set_named_property(env, exports, "getPeerCredentials", fn);
  }
  return exports;
}

NAPI_MODULE(peercred, init)

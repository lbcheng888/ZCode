/** Wire protocol major. A client of another major is refused, never downgraded. */
export const PROTOCOL_VERSION = 1 as const;

/** Contract major of `@zcode/cheng-contract` consumed by this host. */
export const CONTRACT_MAJOR = 1 as const;

/** Host package version; mirrors package.json and is pinned in capabilities. */
export const HOST_VERSION = "0.1.0";

/** Frame cap for inbound requests (plan §4.3: 1 MiB). */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Event cap; larger events become a resultRef on the next status call. */
export const MAX_EVENT_BYTES = 16 * 1024;

/** Startup exit code when the runtime checkout is unusable. */
export const EXIT_RUNTIME_UNAVAILABLE = 78;

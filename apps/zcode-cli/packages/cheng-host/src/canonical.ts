/**
 * Deterministic JSON for hashing: object keys sorted, arrays keep order.
 * Throws on values JSON cannot represent rather than silently dropping them.
 */
export function canonicalJson(value: unknown): string {
  const encoded = encode(value, "$");
  return encoded;
}

function encode(value: unknown, path: string): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`non-finite number at ${path}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => encode(item, `${path}[${index}]`)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const item = record[key];
      if (item === undefined) {
        throw new TypeError(`undefined at ${path}.${key}`);
      }
      parts.push(`${JSON.stringify(key)}:${encode(item, `${path}.${key}`)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(`unsupported JSON value at ${path}: ${typeof value}`);
}

import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  detectLocale,
  getZCodeCopy,
  isUiLocale,
  resolveLocale,
  SUPPORTED_LOCALES,
  type ZCodeCopy,
} from "../src/index.js";

describe("i18n catalog", () => {
  it("resolves supported, auto, and unknown locale values deterministically", () => {
    expect(DEFAULT_LOCALE).toBe("en-US");
    expect(resolveLocale("zh-CN")).toBe("zh-CN");
    expect(resolveLocale("auto", "zh_Hans_CN")).toBe("zh-CN");
    expect(resolveLocale("auto", "en-GB")).toBe("en-US");
    expect(resolveLocale("fr-FR")).toBe("en-US");
    expect(getZCodeCopy("auto", "zh_CN.UTF-8").locale).toBe("zh-CN");
  });

  it("detects supported locales from adapter-provided OS hints", () => {
    expect(detectLocale({ env: { LC_ALL: "zh_CN.UTF-8" } })).toBe("zh-CN");
    expect(detectLocale({ env: { LC_ALL: "C.UTF-8", LC_MESSAGES: "en_GB.UTF-8" } })).toBe("en-US");
    expect(detectLocale({ env: { LANG: "fr_FR.UTF-8" }, intlLocale: "zh-Hans-CN" })).toBe("zh-CN");
    expect(detectLocale({ env: { LANGUAGE: "fr:zh_CN:en_US" } })).toBe("zh-CN");
    expect(detectLocale({ env: { LANG: "POSIX" }, intlLocale: "fr-FR" })).toBeUndefined();
  });

  it("validates UI locale config strings", () => {
    expect(isUiLocale("auto")).toBe(true);
    expect(isUiLocale("en-US")).toBe(true);
    expect(isUiLocale("zh-CN")).toBe(true);
    expect(isUiLocale("fr-FR")).toBe(false);
  });

  it("presents ChengCode as the primary CLI command and zcode as a compatibility alias", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const help = getZCodeCopy(locale).cli.help("1.2.3");
      expect(help.startsWith("ChengCode 1.2.3")).toBe(true);
      expect(help).toContain("chengcode [command] [options]");
      expect(help).toContain("zcode [command] [options]");
      expect(help).toMatch(/alias|别名/);
    }
  });

  it("keeps all locale catalogs shape-compatible", () => {
    const [firstLocale, ...rest] = SUPPORTED_LOCALES;
    const baseShape = catalogShape(getZCodeCopy(firstLocale));

    for (const locale of rest) {
      expect(catalogShape(getZCodeCopy(locale))).toEqual(baseShape);
    }
  });
});

function catalogShape(value: unknown): unknown {
  if (typeof value === "function") return "function";
  if (Array.isArray(value)) return value.map(catalogShape);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        catalogShape(item),
      ]),
    );
  }
  return typeof value;
}

void ({} satisfies Partial<ZCodeCopy>);

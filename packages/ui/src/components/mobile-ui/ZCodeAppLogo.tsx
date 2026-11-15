import type { ZCodeAppLogoProps } from "@/components/mobile-ui/contract.js";
import { cn } from "@/components/lib/utils.js";
import { ChengAppIcon } from "@/components/ui/ChengBrandLogo.js";

/**
 * 应用标（官方 Cheng 深底圆角图标，深浅主题通用）。
 * 装饰性图形：调用方负责在旁边给出可读的品牌文字，避免屏幕阅读器重复朗读。
 */
export function ZCodeAppLogo({ className }: ZCodeAppLogoProps) {
  return (
    <ChengAppIcon
      // 稳定的测试/E2E 钩子：沿用既有标识，避免调用方断言失效。
      data-app-logo="zcode"
      className={cn("select-none", className)}
    />
  );
}

import type { ZCodeAppLogoProps } from "@/components/mobile-ui/contract.js";
import { cn } from "@/components/lib/utils.js";

/**
 * 应用标（ChengCode 紫色圆角底 + 深色 C 图形，自带底色，深浅主题通用）。
 * 装饰性图形：调用方负责在旁边给出可读的品牌文字，避免屏幕阅读器重复朗读。
 */
export function ZCodeAppLogo({ className }: ZCodeAppLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="100"
      height="100"
      viewBox="0 0 100 100"
      // 稳定的测试/E2E 钩子：沿用既有标识，避免调用方断言失效。
      data-app-logo="zcode"
      className={cn("shrink-0 select-none", className)}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="100" height="100" rx="21" fill="#B59AFF" />
      <path
        fill="#211A2D"
        fillRule="evenodd"
        d="M83 28 69 14H61L51 4H42L48 15C26 15 10 32 10 53 10 76 28 94 51 94 69 94 84 84 91 69L73 61C69 70 61 75 52 75 39 75 30 65 30 52 30 40 39 31 51 31H57L64 38H72L75 44 81 38Q88 38 88 33 88 30 83 28ZM65 21 73 25 65 29Z"
      />
    </svg>
  );
}

import { cn } from "@/components/lib/utils.js";

export function ZCodeAboutLogo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="100"
      height="100"
      viewBox="0 0 100 100"
      className={cn("shrink-0", className)}
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

/** 字标在终端/卡片里用文字渲染，避免再次维护一套字母路径。 */
export function ZCodeWordmarkLogo({ className }: { className?: string }) {
  return (
    <span
      className={cn("shrink-0 whitespace-nowrap font-semibold tracking-tight", className)}
      aria-hidden="true"
    >
      ChengCode
    </span>
  );
}

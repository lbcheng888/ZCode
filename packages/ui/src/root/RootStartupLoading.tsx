import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";

interface RootStartupLoadingProps {
  label: string;
  children?: ReactNode;
  busy?: boolean;
}

export function RootStartupLoading({ label, children, busy = true }: RootStartupLoadingProps) {
  return (
    <div
      // Web 端全局 html/body/#root 为 Electron 透明背景让路，React 接管后会替换 HTML 启动壳。
      // 这里必须由阻塞态自身承接主题背景，否则远控链接会在 Root 恢复期间继续露出浏览器白底。
      className="flex h-full min-h-dvh flex-col items-center justify-center gap-6 bg-background text-foreground"
      role="status"
      aria-busy={busy}
      aria-label={label}
      data-testid="root-startup-loading"
    >
      <ZCodeStartupLogoBadge />
      {children}
    </div>
  );
}

/** 初始化与引导共用品牌图标；图形自带 ChengCode 圆角底，外层只负责尺寸与投影。 */
export function ZCodeStartupLogoBadge({
  animated = true,
  size = "default",
}: {
  animated?: boolean;
  size?: "default" | "titlebar";
}) {
  return (
    <div
      data-desktop-logo-badge={size === "titlebar" ? "true" : undefined}
      className={cn(
        "relative flex items-center justify-center overflow-hidden rounded-[21%]",
        size === "titlebar" ? "size-5 shadow-sm/20" : "size-24 shadow-xl/20",
      )}
    >
      <ZCodeStartupLogo className="size-full" animated={animated} />
    </div>
  );
}

export function ZCodeStartupLogo({
  className,
  animated = true,
}: {
  className?: string;
  animated?: boolean;
}) {
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
      {animated ? (
        <animate
          attributeName="opacity"
          begin="3s"
          dur="1.8s"
          repeatCount="indefinite"
          values="1;0.4;1"
        />
      ) : null}
      <rect width="100" height="100" rx="21" fill="#B59AFF" />
      <path
        fill="#211A2D"
        fillRule="evenodd"
        d="M83 28 69 14H61L51 4H42L48 15C26 15 10 32 10 53 10 76 28 94 51 94 69 94 84 84 91 69L73 61C69 70 61 75 52 75 39 75 30 65 30 52 30 40 39 31 51 31H57L64 38H72L75 44 81 38Q88 38 88 33 88 30 83 28ZM65 21 73 25 65 29Z"
      />
    </svg>
  );
}

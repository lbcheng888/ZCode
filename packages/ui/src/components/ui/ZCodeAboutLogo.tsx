import { ChengAppIcon, ChengWordmark } from "@/components/ui/ChengBrandLogo.js";

export function ZCodeAboutLogo({ className }: { className?: string }) {
  return <ChengAppIcon className={className} />;
}

/** 官方 Cheng 字标，用于需要完整品牌字样的终端/卡片场景。 */
export function ZCodeWordmarkLogo({ className }: { className?: string }) {
  return <ChengWordmark className={className} />;
}

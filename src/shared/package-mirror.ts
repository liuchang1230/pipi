/**
 * User-package mirror vocabulary shared by main (settings + reconcile
 * orchestration) and the renderer (ModelConfigDialog toggle). The mirror
 * engine itself lives in src/main/package-mirror.ts and reads only the local
 * packages list — this module is the user-facing switch and its labels.
 *
 * 边界（ADR 0009 的收窄，不是推翻）：默认关闭；只镜像不追新（版本=本机
 * 当前 pin）；只动远程 pi 包清单，settings/auth/skills 永不过境。
 */

export interface PackageMirrorSettings {
  /** Absent/false = the pre-2026-10-07 behavior: user packages never travel. */
  enabled: boolean;
}

export const DEFAULT_PACKAGE_MIRROR_SETTINGS: PackageMirrorSettings = { enabled: false };

export const PACKAGE_MIRROR_LABELS = {
  on: "开启：本机已装的扩展包将自动安装到远程/WSL（版本随本机）",
  off: "关闭：扩展包不同步到远程（默认）",
} as const;

export function normalizePackageMirror(value: unknown): PackageMirrorSettings {
  if (typeof value === "boolean") return { enabled: value };
  if (value && typeof value === "object" && "enabled" in value) {
    return { enabled: (value as { enabled?: unknown }).enabled === true };
  }
  return { ...DEFAULT_PACKAGE_MIRROR_SETTINGS };
}

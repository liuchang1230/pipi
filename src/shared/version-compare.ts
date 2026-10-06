/**
 * 版本号比较：唯一一份实现。pi 漂移（`pi-drift.ts`）与应用自身更新
 * （`update-check.ts`）共用 —— 两份实现就有两种「0.85.10 比 0.85.9 新吗」。
 *
 * 只比较前三段数字，非数字段当 0（`parseInt("x") || 0`）：与 pi / npm 的
 * `x.y.z` 习惯一致，且不为一个比较函数引入 semver 依赖。
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (x !== 0) return Math.sign(x);
  }
  return 0;
}

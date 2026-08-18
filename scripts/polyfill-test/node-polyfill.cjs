// undici 8.x 从 node:worker_threads 读 markAsUncloneable（无 fallback）
// Electron 34 的 Node 20 没有它 → 预加载补上
try {
  const wt = require("node:worker_threads");
  if (typeof wt.markAsUncloneable !== "function") {
    wt.markAsUncloneable = function () {};
  }
} catch {}

/**
 * 从源图 图标1.png 生成应用图标：
 *  - resources/icon.ico —— 多尺寸 ICO（16/24/32/48/64/128/256），Windows
 *    按显示场景取对应尺寸（任务栏大/小图标、标题栏、Alt-Tab、开始菜单），
 *    大图标模式下清晰不模糊。
 *  - resources/icon.png —— 256px 压缩版（非 Windows 平台窗口图标，替代
 *    原 1.3MB 1024x1024 大图）。
 *
 * 用法：node scripts/make-icon.mjs（在仓库根目录运行，需要源图 图标1.png）
 */
import sharp from "sharp";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "图标1.png");

const sizes = [16, 24, 32, 48, 64, 128, 256];

// 1. 各尺寸 PNG
const pngs = await Promise.all(
  sizes.map((s) => sharp(src).resize(s, s, { fit: "contain" }).png().toBuffer()),
);

// 2. 打包 ICO（现代 ICO 条目直接内嵌 PNG）
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(sizes.length, 4);
const entries = [];
let offset = 6 + 16 * sizes.length;
for (let i = 0; i < sizes.length; i++) {
  const e = Buffer.alloc(16);
  const s = sizes[i];
  e.writeUInt8(s === 256 ? 0 : s, 0); // width (0 = 256)
  e.writeUInt8(s === 256 ? 0 : s, 1); // height
  e.writeUInt8(0, 2); // colors
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bitcount
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += pngs[i].length;
}
mkdirSync(join(root, "resources"), { recursive: true });
writeFileSync(join(root, "resources", "icon.ico"), Buffer.concat([header, ...entries, ...pngs]));

// 3. 256px 压缩 PNG（非 Windows 平台）
const png256 = await sharp(src).resize(256, 256, { fit: "contain" }).png().toBuffer();
writeFileSync(join(root, "resources", "icon.png"), png256);

const icoSize = readFileSync(join(root, "resources", "icon.ico")).length;
console.log(`✓ resources/icon.ico (${(icoSize / 1024).toFixed(1)} KB, ${sizes.join("/")}px)`);
console.log(`✓ resources/icon.png (${(png256.length / 1024).toFixed(1)} KB, 256px)`);

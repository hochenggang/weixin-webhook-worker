/**
 * 【可选】交叉验证 cli.mjs 的终端二维码渲染。
 *
 * 二维码实现已定稿，此脚本不再纳入常规校验，仅在改动二维码代码时手动运行：
 *
 *   npm install --no-save qrcode jsqr
 *   node test/manual/qr-cross-check.mjs
 *
 * 渲染链路是「qrcode-svg 生成 SVG → 解析方块还原矩阵 → 半块字符绘制」。
 * 这里要验证的是「还原」这一步没走样，因此用两条独立依据交叉比对：
 *
 *   1. 用第三方的 jsQR 解码还原矩阵，能读回原始文本 —— 这是最硬的证据，
 *      因为它完全不关心我们用哪套编码器、选了哪个掩码。
 *   2. 与 qrcode 库比对「尺寸/版本」与「定位符、时序图」等固定图形。
 *      注意：不同库会在合法范围内选择不同的掩码，因此数据区不能逐格比对，
 *      逐格比对只会得出假阴性（两者都是能扫出来的有效二维码）。
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import jsQR from "jsqr";
import QRCode from "qrcode";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = readFileSync(join(ROOT, "cli.mjs"), "utf8");

/** 截取二维码实现段落（从「二维码渲染」注释块到「子命令」注释块）。 */
function extractQrImplementation(text) {
  const marker = "二维码渲染";
  const start = text.lastIndexOf("/*", text.indexOf(marker));
  const end = text.indexOf("/* ============================ 子命令");
  if (start < 0 || end < 0 || end <= start) throw new Error("无法定位二维码实现段落");
  return text.slice(start, end);
}

const tempFile = join(ROOT, `.qr-extract-${process.pid}.mjs`);
writeFileSync(
  tempFile,
  `import QRCode from "qrcode-svg";\n${extractQrImplementation(source)}\nexport { buildMatrix, renderQr };\n`,
  "utf8",
);

let buildMatrix;
let renderQr;
try {
  ({ buildMatrix, renderQr } = await import(`file://${tempFile.replaceAll("\\", "/")}`));
} finally {
  unlinkSync(tempFile);
}

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  \u2717 ${name}\n      ${error.message}`);
    failed += 1;
  }
};

/** 把矩阵光栅成 jsQR 需要的 RGBA 像素数据（放大 + 静默区，保证解码稳定）。 */
function rasterize({ size, modules }, scale = 8, quiet = 4) {
  const dim = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4);
  for (let py = 0; py < dim; py += 1) {
    for (let px = 0; px < dim; px += 1) {
      const gx = Math.floor(px / scale) - quiet;
      const gy = Math.floor(py / scale) - quiet;
      const dark =
        gx >= 0 && gy >= 0 && gx < size && gy < size && modules[gy * size + gx] === 1;
      const value = dark ? 0 : 255;
      const offset = (py * dim + px) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { data, width: dim, height: dim };
}

const samples = [
  "abc",
  "HELLO WORLD",
  "https://weixin.qq.com/x/QR-TOKEN-1",
  "https://ilinkai.weixin.qq.com/ilink/bot/qrcode?qrcode=abcdef1234567890&t=1700000000",
  "x".repeat(40),
  "https://ilinkai.weixin.qq.com/x/" + "a".repeat(80),
];

console.log("\n[矩阵还原] 用 jsQR 解码比对\n");

for (const content of samples) {
  const label = content.length > 38 ? content.slice(0, 35) + "..." : content;
  const mine = buildMatrix(content);

  check(`可还原矩阵：${label}`, () => {
    assert.ok(mine, "buildMatrix 返回 null");
  });
  if (!mine) continue;

  check(`解码一致：${label}`, () => {
    const image = rasterize(mine);
    const decoded = jsQR(image.data, image.width, image.height);
    assert.ok(decoded, "jsQR 无法解码");
    assert.equal(decoded.data, content);
  });

  const standard = QRCode.create(content, { errorCorrectionLevel: "M" });
  // qrcode-svg 恒用字节模式，qrcode 会尝试更紧凑的模式，故版本可能更大一号；
  // 只要「不小于」标准库所需版本即为合理（都是可扫的有效二维码）。
  check(`版本不小于标准库所需：${label}（${mine.size} vs ${standard.modules.size}）`, () => {
    assert.ok(mine.size >= standard.modules.size, `${mine.size} 小于标准库所需 ${standard.modules.size}`);
    const mineVersion = (mine.size - 17) / 4;
    assert.ok(Number.isInteger(mineVersion), `尺寸 ${mine.size} 不是合法版本`);
  });
}

console.log("\n[固定图形] 与 qrcode 库比对定位符、时序图（掩码无关）\n");

/** 找出第一个样本，逐格比对掩码无关的固定功能图形。 */
check("定位符与掩码无关的固定图形一致", () => {
  const content = samples[2];
  const mine = buildMatrix(content);
  const standard = QRCode.create(content, { errorCorrectionLevel: "M" });
  const size = standard.modules.size;
  assert.equal(mine.size, size, "尺寸不一致，无法继续比对");

  const fixedAt = (x, y) => {
    // 三个定位符（含分隔带）与两条时序图，都是掩码不覆盖的区域。
    if (x < 8 && y < 8) return true;
    if (x >= size - 8 && y < 8) return true;
    if (x < 8 && y >= size - 8) return true;
    if (x === 6 || y === 6) return true;
    return false;
  };

  let checked = 0;
  let mismatches = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!fixedAt(x, y)) continue;
      const a = mine.modules[y * size + x] ? 1 : 0;
      const b = standard.modules.get(x, y) ? 1 : 0;
      checked += 1;
      if (a !== b) mismatches += 1;
    }
  }
  assert.ok(checked > 40, `固定图形取样过少：${checked}`);
  assert.equal(mismatches, 0, `${mismatches}/${checked} 格固定图形不一致`);
});

console.log("\n[终端渲染]");

check("渲染出可打印的字符画", () => {
  const art = renderQr("https://weixin.qq.com/x/QR-TOKEN-1");
  assert.ok(art, "renderQr 返回 null");
  const lines = art.split("\n");
  assert.ok(lines.length > 10, "行数过少");
  assert.match(art, /[█▀▄]/u, "没有绘制出任何深色模块");
});

check("字符画的深色比例在合理区间（非全黑也非全白）", () => {
  const art = renderQr("abc");
  const ink = [...art].filter((c) => c === "█" || c === "▀" || c === "▄").length;
  const total = [...art].filter((c) => c !== "\n").length;
  const ratio = ink / total;
  assert.ok(ratio > 0.1 && ratio < 0.6, `深色比例异常：${ratio.toFixed(3)}`);
});

check("含有二维码定位符特征（左上角实心块）", () => {
  const art = renderQr("abc").split("\n");
  // 静默区 2 模块 → 定位符左边缘在第 2 个字符列起；每 2 模块合成 1 字符行。
  // 左上角定位符最左一列有 7 个连续深色模块，跨越 4 个字符行。
  const ink = new Set(["█", "▀", "▄"]);
  const column = art.slice(1).map((line) => (ink.has(line[2]) ? 1 : 0));
  let best = 0;
  let run = 0;
  for (const value of column) {
    run = value ? run + 1 : 0;
    if (run > best) best = run;
  }
  assert.ok(best >= 3, `定位符左列连续深色段过短：${best}`);
});

check("定位符右侧存在留白分隔带", () => {
  const art = renderQr("abc").split("\n");
  // 定位符宽 7 模块，左边缘在第 2 列 → 第 9 列应为分隔带（浅色）。
  assert.equal(art[1][9], " ", "定位符右侧未出现分隔带");
});

check("字符画宽度与矩阵尺寸成正比", () => {
  const small = renderQr("abc");
  const large = renderQr("https://ilinkai.weixin.qq.com/x/" + "a".repeat(80));
  const widthOf = (art) => art.split("\n")[0].length;
  assert.ok(widthOf(large) > widthOf(small), "更大版本应有更宽的字符画");
});

console.log("\n[边界]");

check("超长内容返回 null 而非抛错", () => {
  assert.equal(buildMatrix("x".repeat(5000)), null);
});

check("空内容不抛错（qrcode-svg 拒绝空串，应安全降级为 null）", () => {
  assert.equal(buildMatrix(""), null);
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);

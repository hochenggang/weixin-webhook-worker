/**
 * 测试专用的模块加载钩子：把 .html 当作文本模块导入。
 *
 * Worker 打包时由 wrangler 的 `[[rules]] type = "Text"` 完成同样的转换
 * （见 wrangler.toml），Node 原生不支持 .html 导入，因此测试里补上这一步，
 * 让 `import INIT_PAGE from "./init.html"` 在两端行为一致。
 */

import { readFile } from "node:fs/promises";

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".html")) return nextLoad(url, context);
  const text = await readFile(new URL(url), "utf8");
  return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(text)};` };
}

// Renders a Markdown file to a bare HTML fragment (GFM tables + fenced code)
// for the handoff PDF pipeline. Usage:
//   node scripts/render-handoff-fragment.mjs <in.md> <out.html>
import { readFileSync, writeFileSync } from "node:fs";
import { marked } from "marked";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node render-handoff-fragment.mjs <in.md> <out.html>");
  process.exit(1);
}

marked.setOptions({ gfm: true, breaks: false });
const html = marked.parse(readFileSync(inPath, "utf8"));
writeFileSync(outPath, html, "utf8");
console.log("rendered", outPath, html.length, "bytes");

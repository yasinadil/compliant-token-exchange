// Wraps the marked-rendered HTML fragment in a print-ready, professionally
// styled HTML document. No external dependencies. Usage:
//   node scripts/wrap-handoff-html.mjs <bodyFragment.html> <output.html>
import { readFileSync, writeFileSync } from "node:fs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node wrap-handoff-html.mjs <in.html> <out.html>");
  process.exit(1);
}

const body = readFileSync(inPath, "utf8");

const css = `
  :root { --ink:#1a1a1a; --muted:#555; --line:#d0d7de; --accent:#0b5cad;
          --code-bg:#f6f8fa; --code-ink:#24292f; }
  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: "Segoe UI", Calibri, Arial, sans-serif; color: var(--ink);
         font-size: 10.5pt; line-height: 1.5; margin: 0; }
  .page { max-width: 820px; margin: 0 auto; padding: 0 8px; }
  h1 { font-size: 22pt; margin: 0 0 4pt; color: var(--ink); letter-spacing:-0.01em; }
  h2 { font-size: 15pt; margin: 22pt 0 6pt; padding-bottom: 4pt;
       border-bottom: 1px solid var(--line); }
  h3 { font-size: 12pt; margin: 16pt 0 4pt; color: #333; }
  h2, h3 { page-break-after: avoid; }
  p { margin: 6pt 0; }
  a { color: var(--accent); text-decoration: none; }
  ul, ol { margin: 6pt 0; padding-left: 20pt; }
  li { margin: 2pt 0; }
  code { font-family: "Cascadia Mono", Consolas, "Courier New", monospace;
         font-size: 9pt; background: var(--code-bg); color: var(--code-ink);
         padding: 1px 4px; border-radius: 3px; }
  pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: 6px;
        padding: 10px 12px; overflow: hidden; page-break-inside: avoid; margin: 8pt 0; }
  pre code { background: none; padding: 0; font-size: 8.6pt; line-height: 1.45;
             white-space: pre-wrap; word-break: break-word; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 9.3pt;
          page-break-inside: avoid; }
  th, td { border: 1px solid var(--line); padding: 5px 8px; text-align: left;
           vertical-align: top; }
  th { background: #f2f5f8; font-weight: 600; }
  tr:nth-child(even) td { background: #fafbfc; }
  blockquote { margin: 8pt 0; padding: 6pt 12pt; border-left: 3px solid var(--accent);
               background: #f5f9fd; color: #33475b; }
  blockquote p { margin: 2pt 0; }
  hr { border: none; border-top: 1px solid var(--line); margin: 16pt 0; }
  /* First table = document-control block: render as a clean key/value card */
  .page > table:first-of-type { width: auto; min-width: 60%; border: 1px solid var(--line); }
  .page > table:first-of-type td:first-child { background:#f2f5f8; font-weight:600; width: 32%; }
  @page { size: A4; margin: 18mm 16mm 20mm 16mm; }
`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SQL Server Sync — Integration Specification</title>
<style>${css}</style>
</head>
<body>
<div class="page">
${body}
</div>
</body>
</html>`;

writeFileSync(outPath, html, "utf8");
console.log("wrote", outPath, html.length, "bytes");

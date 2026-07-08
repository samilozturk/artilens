import { escapeHtml } from "../util/strings.js";

export interface HtmlDocumentOptions {
  title: string;
  emoji?: string;
  body: string;
  styles?: string;
  scripts?: string;
  themeCss?: string;
  description?: string;
}

export function createHtmlDocument(options: HtmlDocumentOptions): string {
  const title = escapeHtml(options.title);
  const emoji = options.emoji ? `${escapeHtml(options.emoji)} ` : "";
  const description = options.description
    ? `<meta name="description" content="${escapeHtml(options.description)}">`
    : "";
  return minifyHtml(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${description}
  <title>${emoji}${title}</title>
  <style>
${baseStyles()}
${options.themeCss ?? ""}
${options.styles ?? ""}
  </style>
</head>
<body>
${options.body}
${options.scripts ? `<script>${options.scripts}</script>` : ""}
</body>
</html>`);
}

export function baseStyles(): string {
  return `
:root{--color-primary:#0b0b0b;--color-accent:#c6613f;--color-surface:#f9f9f7;--color-danger:#8e2626;--color-danger-bg:#fad6d6;--color-danger-bord:#f09595;--color-success:#1f7a4d;--color-success-bg:#e7f2ea;--color-ink:#0b0b0b;--color-muted:#52514e;--color-line:rgba(11,11,11,.1);--color-bord:rgba(11,11,11,.18);--color-card:#ffffff;--color-tint:#f2f1ec;--on-primary:#ffffff;--radius:8px;--radius-sm:6px;--space:8px;--shadow:0 0 0 .5px rgba(11,11,11,.06),0 1px 2px rgba(11,11,11,.05),0 6px 16px -6px rgba(11,11,11,.12);--font-body:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;--font-code:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--color-primary:#ffffff;--color-accent:#d4794f;--color-surface:#0d0d0d;--color-danger:#ec7e7e;--color-danger-bg:#3c0e0e;--color-danger-bord:#641919;--color-success:#5fce93;--color-success-bg:rgba(95,206,147,.1);--color-ink:#ffffff;--color-muted:#c3c2b7;--color-line:rgba(255,255,255,.1);--color-bord:rgba(255,255,255,.2);--color-card:#2c2c2a;--color-tint:rgba(255,255,255,.06);--on-primary:#0b0b0b;--shadow:0 0 0 .5px rgba(255,255,255,.08),0 2px 8px rgba(0,0,0,.4)}}
*{box-sizing:border-box}
body{margin:0;background:var(--color-surface);color:var(--color-ink);font-family:var(--font-body);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:var(--color-accent);text-decoration:none}a:hover{text-decoration:underline}
main{max-width:1040px;margin:0 auto;padding:40px 24px 64px}
main>section{margin-top:16px}
.al-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:8px;padding:4px 2px 20px;border-bottom:1px solid var(--color-line)}
.al-title{margin:0;font-size:28px;font-weight:600;line-height:1.15;letter-spacing:-.02em}
.al-subtitle{margin:8px 0 0;color:var(--color-muted);font-size:14px;max-width:72ch}
.al-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.al-panel{background:var(--color-card);border:1px solid var(--color-line);border-radius:var(--radius);padding:20px 22px;box-shadow:var(--shadow)}
.al-panel>h2{margin:0 0 16px;font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--color-muted)}
.al-kpi{font-size:26px;font-weight:600;letter-spacing:-.02em}
.al-muted{color:var(--color-muted)}
.al-pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--color-line);border-radius:999px;padding:4px 11px;background:var(--color-tint);font-size:12px;font-weight:500;color:var(--color-muted);white-space:nowrap}
.al-danger{color:var(--color-danger)}.al-success{color:var(--color-success)}.al-warning{color:#b45309}
table{width:100%;border-collapse:collapse;background:transparent;font-size:13px}
th,td{border-bottom:1px solid var(--color-line);padding:9px 12px;text-align:left;vertical-align:top}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--color-tint)}
th{font-size:11px;color:var(--color-muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600}
th button{all:unset;cursor:pointer;font:inherit;color:inherit;text-transform:inherit;letter-spacing:inherit}
th button:hover{color:var(--color-accent)}
pre,code{font-family:var(--font-code)}
pre{overflow:auto;background:#111110;color:#e8e6df;padding:16px;border-radius:var(--radius-sm);font-size:12.5px;line-height:1.6;border:1px solid var(--color-line)}
:not(pre)>code{background:var(--color-tint);border:1px solid var(--color-line);border-radius:4px;padding:1px 5px;font-size:.9em}
button{font:inherit;font-weight:500;border:1px solid var(--color-bord);background:var(--color-card);color:var(--color-ink);border-radius:var(--radius-sm);padding:7px 13px;cursor:pointer;transition:border-color .12s,background .12s}
button:hover{border-color:var(--color-ink);background:var(--color-tint)}
input[type=checkbox],input[type=radio]{accent-color:var(--color-accent)}
@media (max-width:720px){main{padding:24px 14px 40px}.al-header{display:block}.al-title{font-size:23px}.al-panel{padding:16px}table{font-size:12px}}
`;
}

// The shield marker cannot appear in valid HTML text and is not matched by \s, so
// it is a safe transient placeholder: it survives the whitespace-collapse passes
// below and is fully removed before the string is returned.
const SHIELD = String.fromCharCode(0);
const SHIELD_RE = new RegExp(`${SHIELD}(\\d+)${SHIELD}`, "g");

export function minifyHtml(input: string): string {
  // Protect whitespace-sensitive regions (code, scripts, form fields) so the
  // collapse passes cannot eat code indentation or corrupt embedded JSON.
  const guarded: string[] = [];
  const shielded = input.replace(/<(pre|script|textarea)\b[\s\S]*?<\/\1>/gi, (match) => {
    guarded.push(match);
    return `${SHIELD}${guarded.length - 1}${SHIELD}`;
  });
  const minified = shielded
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
  return minified.replace(SHIELD_RE, (_, index) => guarded[Number(index)] ?? "");
}

export function parseTitle(html: string, fallback = "ArtiLens Artifact"): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  return stripTags(title || h1 || fallback).trim() || fallback;
}

export function summarizeHtml(html: string, max = 180): string {
  const title = parseTitle(html, "");
  const paragraph = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1] ?? "";
  const text = stripTags(`${title}. ${paragraph}`).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

export function stripTags(input: string): string {
  return input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

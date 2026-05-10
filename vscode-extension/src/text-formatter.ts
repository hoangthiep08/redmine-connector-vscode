import { marked } from "marked";
import * as vscode from "vscode";

export type TextFormat = "textile" | "markdown" | "plain";

export function getConfiguredFormat(): TextFormat {
  const val = vscode.workspace.getConfiguration("redmine").get<string>("textFormat") ?? "textile";
  return val as TextFormat;
}

export function renderText(text: string, format?: TextFormat, baseUrl?: string): string {
  if (!text) return "";
  const fmt = format ?? getConfiguredFormat();
  if (fmt === "markdown") return renderMarkdown(text, baseUrl);
  if (fmt === "textile") return renderTextile(text, baseUrl);
  return `<p style="white-space:pre-wrap">${escHtml(text)}</p>`;
}

// ── Markdown ────────────────────────────────────────────────────────────────

function renderMarkdown(text: string, baseUrl?: string): string {
  marked.use({ breaks: true, gfm: true, async: false });
  let result = marked.parse(text);
  if (typeof result !== "string") return escHtml(text);
  // Proxy image src through extension (Redmine requires auth)
  result = result.replace(/<img([^>]*)\ssrc="([^"]*)"([^>]*?)>/gi, (_, pre, src, post) => {
    const fullSrc = src.startsWith("/") && baseUrl ? `${baseUrl}${src}` : src;
    return `<img${pre} class="rich-img" data-src="${fullSrc.replace(/"/g, "&quot;")}" src=""${post}>`;
  });
  return result;
}

// ── Textile ─────────────────────────────────────────────────────────────────
// Covers the subset Redmine actually uses.

function renderTextile(raw: string, baseUrl?: string): string {
  let text = raw;

  // Protect code blocks first (pre/code)
  const codeBlocks: string[] = [];
  text = text.replace(/<pre>([\s\S]*?)<\/pre>/gi, (_, code) => {
    codeBlocks.push(`<pre><code>${escHtml(code.trim())}</code></pre>`);
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const cls = lang ? ` class="language-${escHtml(lang)}"` : "";
    codeBlocks.push(`<pre><code${cls}>${escHtml(code.trim())}</code></pre>`);
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });
  // Inline @code@
  text = text.replace(/@([^@\n]+)@/g, (_, c) => `<code>${escHtml(c)}</code>`);

  // Headings: h1. h2. … h6.
  text = text.replace(/^h([1-6])\.\s+(.+)$/gm, (_, n, t) => `<h${n}>${t}</h${n}>`);

  // Bold / italic / underline / strike
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*\n]+?)\*/g, "<strong>$1</strong>");
  text = text.replace(/__(.+?)__/g, "<em>$1</em>");
  text = text.replace(/_([^_\n]+?)_/g, "<em>$1</em>");
  text = text.replace(/\+([^+\n]+?)\+/g, "<ins>$1</ins>");
  text = text.replace(/-([^-\n]+?)-/g, "<del>$1</del>");

  // Images: !url! or !url(title)!
  text = text.replace(/!([^!\s<>]+?)(?:\(([^)]*)\))?!/g, (_, url, title) => {
    const fullSrc = url.startsWith("/") && baseUrl ? `${baseUrl}${url}` : url;
    return `<img class="rich-img" data-src="${fullSrc.replace(/"/g, "&quot;")}" src="" alt="${escHtml(title || '')}">`;
  });

  // Links: "text":url
  text = text.replace(/"([^"]+)":(\S+)/g, '<a href="$2" target="_blank">$1</a>');
  // Auto links
  text = text.replace(/(?<![">])(https?:\/\/\S+)/g, '<a href="$1" target="_blank">$1</a>');

  // Blockquote: lines starting with >
  text = text.replace(/(^>.*(\n|$))+/gm, (block) => {
    const inner = block.replace(/^>\s?/gm, "").trim();
    return `<blockquote>${inner}</blockquote>`;
  });

  // Unordered list: lines starting with * or -
  text = processLists(text, /^\*\s+(.+)$/gm, /^-\s+(.+)$/gm);

  // Ordered list: lines starting with #
  text = processOrderedLists(text, /^#\s+(.+)$/gm);

  // Table: |col|col|
  text = processTables(text);

  // Paragraphs: wrap non-tagged blocks
  text = text
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      if (/^\x00CODE/.test(trimmed)) return trimmed;
      if (/^<(h[1-6]|ul|ol|li|table|blockquote|pre|div)/.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");

  // Restore code blocks
  text = text.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i)]);

  return text;
}

function processLists(text: string, ...patterns: RegExp[]): string {
  for (const pattern of patterns) {
    text = text.replace(/((?:^[*-]\s+.+\n?)+)/gm, (block) => {
      const items = block
        .trim()
        .split("\n")
        .map((l) => l.replace(/^[*-]\s+/, "").trim())
        .filter(Boolean)
        .map((l) => `<li>${l}</li>`)
        .join("");
      return `<ul>${items}</ul>`;
    });
  }
  return text;
}

function processOrderedLists(text: string, _pattern: RegExp): string {
  return text.replace(/((?:^#\s+.+\n?)+)/gm, (block) => {
    const items = block
      .trim()
      .split("\n")
      .map((l) => l.replace(/^#\s+/, "").trim())
      .filter(Boolean)
      .map((l) => `<li>${l}</li>`)
      .join("");
    return `<ol>${items}</ol>`;
  });
}

function processTables(text: string): string {
  return text.replace(/((?:^\|.+\|\n?)+)/gm, (block) => {
    const rows = block.trim().split("\n").filter(Boolean);
    let html = "<table>";
    rows.forEach((row, i) => {
      const cells = row
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      const tag = i === 0 ? "th" : "td";
      html += "<tr>" + cells.map((c) => `<${tag}>${c}</${tag}>`).join("") + "</tr>";
    });
    return html + "</table>";
  });
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// CSS to inject into the webview for rendered text
export const FORMATTER_CSS = `
  .rich-text { line-height: 1.7; }
  .rich-text p { margin: 0 0 10px; }
  .rich-text h1,.rich-text h2,.rich-text h3,.rich-text h4 { margin: 16px 0 8px; font-weight: 600; }
  .rich-text h1 { font-size: 1.3em; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 4px; }
  .rich-text h2 { font-size: 1.15em; }
  .rich-text h3 { font-size: 1.05em; }
  .rich-text ul, .rich-text ol { margin: 6px 0 10px 20px; padding: 0; }
  .rich-text li { margin: 3px 0; }
  .rich-text blockquote { border-left: 3px solid var(--vscode-textBlockQuote-border); background: var(--vscode-textBlockQuote-background); margin: 8px 0; padding: 6px 12px; border-radius: 0 4px 4px 0; color: var(--vscode-descriptionForeground); }
  .rich-text code { background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; }
  .rich-text pre { background: var(--vscode-textCodeBlock-background); border-radius: 6px; padding: 12px 16px; overflow-x: auto; margin: 10px 0; }
  .rich-text pre code { background: none; padding: 0; font-size: 0.88em; line-height: 1.5; }
  .rich-text a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .rich-text a:hover { text-decoration: underline; }
  .rich-text ins { text-decoration: underline; }
  .rich-text del { text-decoration: line-through; color: var(--vscode-descriptionForeground); }
  .rich-text table { border-collapse: collapse; margin: 10px 0; width: 100%; }
  .rich-text th, .rich-text td { border: 1px solid var(--vscode-widget-border); padding: 6px 10px; text-align: left; }
  .rich-text th { background: var(--vscode-editor-inactiveSelectionBackground); font-weight: 600; }
  .rich-text img { max-width: 100%; border-radius: 4px; cursor: pointer; }
  .rich-text hr { border: none; border-top: 1px solid var(--vscode-widget-border); margin: 16px 0; }
`;

#!/usr/bin/env node
// Verify that <script>...</script> blocks inside webview TS template literals
// produce syntactically valid JavaScript after TS escape processing.
//
// Catches bugs where a regex like /\n/g sits inside a TS template literal
// and gets cooked into a real newline, silently breaking the entire webview.
//
// Usage: node scripts/check-webview-scripts.js src/*.ts

const fs = require("fs");

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("Usage: node check-webview-scripts.js <file.ts> [...]");
  process.exit(2);
}

function stripInterpolations(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "$" && src[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) { i++; break; }
        }
        i++;
      }
      out += "null";
    } else {
      out += src[i++];
    }
  }
  return out;
}

function lineOfOffset(src, offset) {
  return src.slice(0, offset).split("\n").length;
}

let hadError = false;

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.warn(`skip (not found): ${file}`);
    continue;
  }
  const src = fs.readFileSync(file, "utf8");
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  let idx = 0;
  while ((m = re.exec(src)) !== null) {
    idx++;
    const blockLine = lineOfOffset(src, m.index);
    const stripped = stripInterpolations(m[1]);

    // Apply TS template-literal escape processing by re-wrapping the content
    // in a real template literal. `\n`, `\t`, etc. get cooked the same way TS
    // would when emitting the .js — only ` and ${ need re-escaping.
    let cooked;
    try {
      const wrapped = stripped.replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
      cooked = new Function("return `" + wrapped + "`")();
    } catch (e) {
      console.error(`✗ ${file} <script> starting near line ${blockLine}: cook failed — ${e.message}`);
      hadError = true;
      continue;
    }

    try {
      new Function(cooked);
    } catch (e) {
      console.error(`✗ ${file} <script> #${idx} starting near line ${blockLine}: ${e.message}`);
      hadError = true;
    }
  }
}

if (!hadError) console.log("✓ Webview <script> blocks: syntax OK");
process.exit(hadError ? 1 : 0);

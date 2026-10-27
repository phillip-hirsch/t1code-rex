#!/usr/bin/env node
// Renders a tmux pane running tr3x to a PNG for PR evidence: `screenshot.mjs <target> <out.png>`.
// Colors come from `tmux capture-pane -e`; headless Chrome draws them with a Nerd Font.
// The full recipe is in AGENTS.md. CHROME_BIN and SCREENSHOT_FONT override the defaults.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Its own tmux server with no config, so the user's tmux sessions and settings never apply.
// TR3X_SHOT_SOCKET picks another server; agents running side by side share this one, so
// each uses its own session name and stops only that session. Targets are exact ("=name"):
// tmux otherwise matches a session name by prefix.
const TMUX = ["-L", process.env.TR3X_SHOT_SOCKET || "tr3x-shot", "-f", "/dev/null"];
const args = process.argv.slice(2);
const USAGE = `usage:
  screenshot.mjs start <name> [--size 140x40] -- <command...>   start the TUI in a detached tmux session
  screenshot.mjs <name> <out.png>                                capture that session to a PNG
  screenshot.mjs stop <name>                                     stop that session only`;

if (args[0] === "stop") {
  if (!args[1]) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    NodeChildProcess.execFileSync("tmux", [...TMUX, "kill-session", "-t", `=${args[1]}`], {
      stdio: "ignore",
    });
  } catch {
    // Already gone.
  }
  process.exit(0);
}

if (args[0] === "start") {
  const name = args[1];
  const sep = args.indexOf("--");
  const sizeAt = args.indexOf("--size");
  const [width, height] = (sizeAt > 0 && sizeAt < sep ? args[sizeAt + 1] : "140x40").split("x");
  if (!name || sep < 0 || sep === args.length - 1) {
    console.error(USAGE);
    process.exit(2);
  }
  const tmux = (...tmuxArgs) =>
    NodeChildProcess.execFileSync("tmux", [...TMUX, ...tmuxArgs], { stdio: "inherit" });
  const command = args
    .slice(sep + 1)
    .map((part) => `'${part.replace(/'/g, "'\\''")}'`)
    .join(" ");
  tmux("new-session", "-d", "-s", name, "-x", width, "-y", height, command);
  // Without the status bar and with a fixed size, the pane is exactly width x height.
  tmux("set", "-t", `=${name}:`, "status", "off");
  tmux("set", "-t", `=${name}:`, "window-size", "manual");
  tmux("resize-window", "-t", `=${name}:`, "-x", width, "-y", height);
  process.exit(0);
}

const [target, outPath] = args;
if (!target || !outPath) {
  console.error(USAGE);
  process.exit(2);
}

const CHROME =
  process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FONT =
  process.env.SCREENSHOT_FONT ?? '"JetBrainsMonoNL Nerd Font", "JetBrainsMono Nerd Font"';
const FONT_PX = 14;
const LINE_PX = 17;
const CHAR_PX = 8.4; // JetBrains Mono advance at 14px
const PAD_PX = 10;
const DEFAULT_FG = "#e5e5e5";
const DEFAULT_BG = "#1b1b1b";

const [cols, rows] = NodeChildProcess.execFileSync(
  "tmux",
  [...TMUX, "display", "-p", "-t", `=${target}:`, "#{pane_width} #{pane_height}"],
  {
    encoding: "utf8",
  },
)
  .trim()
  .split(" ")
  .map(Number);
const ansi = NodeChildProcess.execFileSync(
  "tmux",
  [...TMUX, "capture-pane", "-p", "-e", "-N", "-t", `=${target}:`],
  {
    encoding: "utf8",
  },
);

// xterm's 256-color palette.
const BASE16 = [
  "#000000",
  "#cd0000",
  "#00cd00",
  "#cdcd00",
  "#0000ee",
  "#cd00cd",
  "#00cdcd",
  "#e5e5e5",
  "#7f7f7f",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#5c5cff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
];
function color256(n) {
  if (n < 16) return BASE16[n];
  if (n < 232) {
    const steps = [0, 95, 135, 175, 215, 255];
    const v = n - 16;
    return `rgb(${steps[Math.floor(v / 36)]},${steps[Math.floor(v / 6) % 6]},${steps[v % 6]})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

// Terminal cell width of a grapheme: wide East Asian characters and emoji-presentation
// characters take two cells; text-default symbols such as 🖥 take one, as in tmux.
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]|\p{Emoji_Presentation}|\uFE0F/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const escapeHtml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderLine(line) {
  const style = {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
  };
  let html = "";
  const span = (text) => {
    if (!text) return;
    let fg = style.fg ?? DEFAULT_FG;
    let bg = style.bg;
    if (style.inverse) [fg, bg] = [bg ?? DEFAULT_BG, fg];
    const css = [`color:${fg}`];
    if (bg) css.push(`background:${bg}`);
    if (style.bold) css.push("font-weight:700");
    if (style.dim) css.push("opacity:.6");
    if (style.italic) css.push("font-style:italic");
    if (style.underline) css.push("text-decoration:underline");
    // Each grapheme gets its terminal cells' width, so wide glyphs and font fallbacks can't
    // shift the columns after them.
    let cells = "";
    for (const { segment } of segmenter.segment(text)) {
      const width = (WIDE.test(segment) ? 2 : 1) * CHAR_PX;
      cells += `<i style="display:inline-block;width:${width}px;font-style:inherit;text-decoration:inherit">${escapeHtml(segment)}</i>`;
    }
    html += `<span style="${css.join(";")}">${cells}</span>`;
  };
  const parts = line.split(/\x1b\[([0-9;:]*)m/);
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2 === 0) {
      span(parts[i]);
      continue;
    }
    const codes = parts[i] === "" ? [0] : parts[i].split(/[;:]/).map(Number);
    for (let j = 0; j < codes.length; j += 1) {
      const code = codes[j];
      if (code === 0)
        Object.assign(style, {
          fg: null,
          bg: null,
          bold: false,
          dim: false,
          italic: false,
          underline: false,
          inverse: false,
        });
      else if (code === 1) style.bold = true;
      else if (code === 2) style.dim = true;
      else if (code === 3) style.italic = true;
      else if (code === 4) style.underline = true;
      else if (code === 7) style.inverse = true;
      else if (code === 22) Object.assign(style, { bold: false, dim: false });
      else if (code === 23) style.italic = false;
      else if (code === 24) style.underline = false;
      else if (code === 27) style.inverse = false;
      else if (code === 39) style.fg = null;
      else if (code === 49) style.bg = null;
      else if (code >= 30 && code <= 37) style.fg = BASE16[code - 30];
      else if (code >= 90 && code <= 97) style.fg = BASE16[code - 90 + 8];
      else if (code >= 40 && code <= 47) style.bg = BASE16[code - 40];
      else if (code >= 100 && code <= 107) style.bg = BASE16[code - 100 + 8];
      else if (code === 38 || code === 48) {
        const key = code === 38 ? "fg" : "bg";
        if (codes[j + 1] === 2) {
          style[key] = `rgb(${codes[j + 2]},${codes[j + 3]},${codes[j + 4]})`;
          j += 4;
        } else if (codes[j + 1] === 5) {
          style[key] = color256(codes[j + 2]);
          j += 2;
        }
      }
    }
  }
  return html;
}

const lines = ansi.replace(/\n$/, "").split("\n").slice(0, rows);
const body = lines.map((line) => `<div class="row">${renderLine(line) || " "}</div>`).join("");
const page = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:${DEFAULT_BG};}
.screen{padding:${PAD_PX}px;font-family:${FONT},monospace;font-size:${FONT_PX}px;line-height:${LINE_PX}px;white-space:pre;color:${DEFAULT_FG};}
.row{height:${LINE_PX}px;}
</style></head><body><div class="screen">${body}</div></body></html>`;

const out = NodePath.resolve(outPath);
NodeFS.mkdirSync(NodePath.dirname(out), { recursive: true });
NodeFS.rmSync(out, { force: true });
const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tr3x-shot-"));
try {
  const htmlPath = NodePath.join(dir, "screen.html");
  NodeFS.writeFileSync(htmlPath, page);
  const width = Math.ceil(cols * CHAR_PX) + PAD_PX * 2;
  const height = rows * LINE_PX + PAD_PX * 2;
  NodeChildProcess.execFileSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      `file://${htmlPath}`,
    ],
    { stdio: "ignore" },
  );
} finally {
  NodeFS.rmSync(dir, { recursive: true, force: true });
}
// Chrome can exit 0 without writing the file.
if (!NodeFS.existsSync(out) || NodeFS.statSync(out).size === 0) {
  console.error(`Chrome didn't write ${out}`);
  process.exit(1);
}
console.log(`${out} (${cols}x${rows})`);

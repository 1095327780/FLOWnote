const { setIcon } = require("obsidian");

const TOOL_ICON_MAP = {
  read: "file-text",
  write: "file-pen",
  edit: "file-pen",
  bash: "terminal-square",
  ls: "folder-tree",
  glob: "search",
  grep: "search-code",
  web_search: "globe",
  web_fetch: "globe",
  skill: "sparkles",
  question: "circle-help",
  todo_write: "list-checks",
};

function setNodeText(node, text) {
  if (!node) return;
  const value = String(text || "");
  if (typeof node.setText === "function") {
    node.setText(value);
  } else {
    node.textContent = value;
  }
}

function emptyNode(node) {
  if (!node) return;
  if (typeof node.empty === "function") {
    node.empty();
  } else {
    node.innerHTML = "";
  }
}

function markdownRenderKey(text) {
  const raw = String(text || "");
  return `${raw.length}:${raw.slice(0, 120)}`;
}

function safeSetIcon(el, iconName) {
  if (!el) return;
  try {
    setIcon(el, iconName);
  } catch {
    try {
      setIcon(el, "circle");
    } catch {
      // ignore invalid icon names
    }
  }
}

async function copyTextToClipboard(text) {
  await navigator.clipboard.writeText(String(text || ""));
}

function applyCopyGlyph(el) {
  if (!el) return;
  el.innerHTML = "";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const rectBack = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rectBack.setAttribute("x", "9");
  rectBack.setAttribute("y", "9");
  rectBack.setAttribute("width", "11");
  rectBack.setAttribute("height", "11");
  rectBack.setAttribute("rx", "2");
  rectBack.setAttribute("fill", "none");
  rectBack.setAttribute("stroke", "currentColor");
  rectBack.setAttribute("stroke-width", "1.8");
  const rectFront = document.createElementNS("http://www.w3.org/2000/svg", "path");
  rectFront.setAttribute("d", "M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1");
  rectFront.setAttribute("fill", "none");
  rectFront.setAttribute("stroke", "currentColor");
  rectFront.setAttribute("stroke-width", "1.8");
  rectFront.setAttribute("stroke-linecap", "round");
  rectFront.setAttribute("stroke-linejoin", "round");
  svg.appendChild(rectBack);
  svg.appendChild(rectFront);
  el.appendChild(svg);
}

function showCopyFeedback(el, restore) {
  if (!el) return;
  const prev = el.getAttribute("data-copying");
  if (prev === "1") return;
  el.setAttribute("data-copying", "1");
  el.classList.add("copied");
  el.textContent = "copied!";
  setTimeout(() => {
    el.removeAttribute("data-copying");
    el.classList.remove("copied");
    if (typeof restore === "function") restore();
  }, 1400);
}

function resolveToolIconName(toolName) {
  const key = String(toolName || "").trim().toLowerCase();
  return TOOL_ICON_MAP[key] || "wrench";
}

function applyToolStatusIcon(el, status) {
  if (!el) return;
  const normalizedStatus = String(status || "pending").trim().toLowerCase();
  el.className = "oc-tool-status";
  el.classList.add(`status-${normalizedStatus}`);
  el.empty();

  if (normalizedStatus === "completed") {
    safeSetIcon(el, "check");
    return;
  }
  if (normalizedStatus === "error") {
    safeSetIcon(el, "x");
    return;
  }
  if (normalizedStatus === "running") {
    safeSetIcon(el, "loader-circle");
    return;
  }
  safeSetIcon(el, "clock3");
}


const domUtils = {
  setNodeText,
  emptyNode,
  safeSetIcon,
  copyTextToClipboard,
  applyCopyGlyph,
  showCopyFeedback,
  resolveToolIconName,
  applyToolStatusIcon,
};

module.exports = { domUtils };

const { Notice, MarkdownRenderer, Keymap } = require("obsidian");
const { normalizeMarkdownForDisplay } = require("../../assistant-payload-utils");
const { domUtils } = require("./dom-utils");

const {
  setNodeText,
  emptyNode,
  copyTextToClipboard,
  applyCopyGlyph,
  showCopyFeedback,
} = domUtils;

const MARKDOWN_RENDER_STATE = new WeakMap();

function markdownRenderKey(text) {
  const raw = String(text || "");
  return `${raw.length}:${raw.slice(0, 120)}`;
}


function ensureCodeWrapper(pre) {
  if (!pre || !pre.parentElement) return null;
  if (pre.parentElement.classList.contains("oc-code-wrapper")) {
    return pre.parentElement;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "oc-code-wrapper";
  pre.parentElement.insertBefore(wrapper, pre);
  wrapper.appendChild(pre);
  return wrapper;
}

function ensureCodeCopyButton(wrapper, codeText) {
  if (!wrapper) return;
  let btn = wrapper.querySelector(".oc-code-copy-btn");
  if (!btn) {
    btn = document.createElement("button");
    btn.className = "oc-code-copy-btn";
    btn.type = "button";
    btn.setAttribute("aria-label", "复制代码");
    wrapper.appendChild(btn);
  }

  applyCopyGlyph(btn);
  btn.onclick = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await copyTextToClipboard(codeText || "");
      showCopyFeedback(btn, () => {
        applyCopyGlyph(btn);
      });
    } catch {
      new Notice("复制失败");
    }
  };
}

function enhanceCodeBlocks(container) {
  if (!container) return;
  container.querySelectorAll("pre").forEach((pre) => {
    const wrapper = ensureCodeWrapper(pre);
    if (!wrapper) return;

    const codeEl = pre.querySelector("code");
    const codeText = codeEl ? codeEl.innerText : pre.innerText;

    ensureCodeCopyButton(wrapper, codeText);

    const obsidianCopy = wrapper.querySelector(".copy-code-button");
    if (obsidianCopy) obsidianCopy.remove();
  });
}

function attachCodeCopyButtons(container) {
  this.enhanceCodeBlocks(container);
}

function getMarkdownRenderSourcePath() {
  const file = this.app
    && this.app.workspace
    && typeof this.app.workspace.getActiveFile === "function"
    ? this.app.workspace.getActiveFile()
    : null;
  return file && typeof file.path === "string" ? file.path : "";
}

function decodeLinkText(value) {
  const text = String(value || "");
  if (!text) return "";
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function resolveObsidianUriTarget(href) {
  const raw = String(href || "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  if (String(url.protocol || "").toLowerCase() !== "obsidian:") return "";
  const path = decodeLinkText(url.searchParams.get("path") || "");
  if (path) return path;
  const file = decodeLinkText(url.searchParams.get("file") || "");
  return file;
}

function resolveInternalLinkText(anchorEl) {
  if (!anchorEl) return "";

  const dataHref = String(anchorEl.getAttribute("data-href") || "").trim();
  if (dataHref) return decodeLinkText(dataHref);

  const href = String(anchorEl.getAttribute("href") || "").trim();
  if (!href) return "";
  if (href.startsWith("#")) return "";

  const obsidianTarget = resolveObsidianUriTarget(href);
  if (obsidianTarget) return obsidianTarget;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return "";
  return decodeLinkText(href.replace(/^\.\//, ""));
}

function attachInternalLinkHandlers(container) {
  if (!container || !this.app || !this.app.workspace) return;
  const sourcePath = this.getMarkdownRenderSourcePath();
  container.querySelectorAll("a").forEach((anchorEl) => {
    if (!anchorEl || anchorEl.dataset.ocLinkBound === "1") return;
    anchorEl.dataset.ocLinkBound = "1";

    const linktext = this.resolveInternalLinkText(anchorEl);
    if (!linktext) return;

    anchorEl.addEventListener("click", (evt) => {
      if (!evt || (evt.button !== 0 && evt.button !== 1)) return;
      evt.preventDefault();
      evt.stopPropagation();
      const modEvent = typeof Keymap !== "undefined" && Keymap && typeof Keymap.isModEvent === "function"
        ? Keymap.isModEvent(evt)
        : Boolean(evt.metaKey || evt.ctrlKey);
      const openInNewLeaf = Boolean(modEvent || evt.button === 1);
      void this.app.workspace.openLinkText(linktext, sourcePath, openInNewLeaf);
    });

    anchorEl.addEventListener("mouseover", (evt) => {
      this.app.workspace.trigger("hover-link", {
        event: evt,
        source: "flownote",
        hoverParent: this,
        targetEl: anchorEl,
        linktext,
      });
    });
  });
}

function renderMarkdownSafely(container, markdownText, onRendered) {
  if (!container) return;
  const text = String(markdownText || "");
  if (!text.trim()) {
    MARKDOWN_RENDER_STATE.delete(container);
    emptyNode(container);
    return;
  }

  const key = markdownRenderKey(text);
  const previous = MARKDOWN_RENDER_STATE.get(container);
  if (previous && previous.rendered && previous.key === key) return;

  const version = Number(previous && previous.version ? previous.version : 0) + 1;
  MARKDOWN_RENDER_STATE.set(container, {
    key,
    version,
    rendered: false,
  });

  const staging = document.createElement("div");
  const sourcePath = this.getMarkdownRenderSourcePath();
  MarkdownRenderer.render(this.app, text, staging, sourcePath, this.plugin)
    .then(() => {
      const latest = MARKDOWN_RENDER_STATE.get(container);
      if (!latest || latest.version !== version) return;
      emptyNode(container);
      while (staging.firstChild) {
        container.appendChild(staging.firstChild);
      }
      MARKDOWN_RENDER_STATE.set(container, {
        key,
        version,
        rendered: true,
      });
      this.attachInternalLinkHandlers(container);
      if (typeof onRendered === "function") onRendered();
      const shouldForceBottom = Boolean(
        this.currentAbort
        || (typeof this.hasActiveForceBottom === "function" && this.hasActiveForceBottom()),
      );
      this.scheduleScrollMessagesToBottom(shouldForceBottom);
    })
    .catch(() => {
      const latest = MARKDOWN_RENDER_STATE.get(container);
      if (!latest || latest.version !== version) return;
      emptyNode(container);
      setNodeText(container, text);
      MARKDOWN_RENDER_STATE.set(container, {
        key,
        version,
        rendered: true,
      });
      const shouldForceBottom = Boolean(
        this.currentAbort
        || (typeof this.hasActiveForceBottom === "function" && this.hasActiveForceBottom()),
      );
      this.scheduleScrollMessagesToBottom(shouldForceBottom);
    });
}


const markdownMethods = {
  attachCodeCopyButtons,
  attachInternalLinkHandlers,
  getMarkdownRenderSourcePath,
  resolveInternalLinkText,
  renderMarkdownSafely,
  enhanceCodeBlocks,
};

module.exports = {
  MARKDOWN_RENDER_STATE,
  markdownMethods,
};

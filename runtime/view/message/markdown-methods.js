const { Notice, MarkdownRenderer, Keymap } = require("obsidian");
const { normalizeMarkdownForDisplay } = require("../../assistant-payload-utils");
const { domUtils } = require("./dom-utils");
const { tFromContext } = require("../../i18n-runtime");
const {
  extractVaultPathMatchesFromText,
  resolveVaultPathCandidate,
} = require("./vault-path-links");

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

function ensureCodeCopyButton(wrapper, codeText, context) {
  if (!wrapper) return;
  let btn = wrapper.querySelector(".oc-code-copy-btn");
  if (!btn) {
    btn = document.createElement("button");
    btn.className = "oc-code-copy-btn";
    btn.type = "button";
    btn.setAttribute("aria-label", tFromContext(context, "view.message.copyCode", "Copy code"));
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
      new Notice(tFromContext(context, "view.message.copyFailed", "Copy failed"));
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

    ensureCodeCopyButton(wrapper, codeText, this);

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

function createVaultPathAnchor(linkPath, labelText, titleText) {
  const anchor = document.createElement("a");
  anchor.className = "oc-vault-path-link internal-link";
  anchor.setAttribute("href", linkPath);
  anchor.setAttribute("data-href", linkPath);
  anchor.setAttribute("title", titleText || linkPath);
  anchor.textContent = labelText || linkPath;
  return anchor;
}

function shouldSkipVaultPathTextNode(textNode) {
  const parent = textNode && textNode.parentElement;
  if (!parent || typeof parent.closest !== "function") return true;
  return Boolean(parent.closest("a, code, pre, script, style, textarea"));
}

function enhanceInlineCodeVaultPathLinks(container) {
  if (!container || typeof container.querySelectorAll !== "function") return;
  container.querySelectorAll("code").forEach((codeEl) => {
    if (!codeEl || !codeEl.parentNode) return;
    if (typeof codeEl.closest === "function" && codeEl.closest("a, pre")) return;

    const label = String(codeEl.textContent || "").trim();
    if (!label) return;
    const linkPath = resolveVaultPathCandidate(this, label);
    if (!linkPath) return;

    const anchor = createVaultPathAnchor(linkPath, "", label);
    anchor.textContent = "";
    codeEl.parentNode.insertBefore(anchor, codeEl);
    anchor.appendChild(codeEl);
  });
}

function enhanceTextNodeVaultPathLinks(textNode) {
  if (!textNode || !textNode.parentNode || shouldSkipVaultPathTextNode(textNode)) return;
  const text = String(textNode.nodeValue || "");
  const matches = extractVaultPathMatchesFromText(text)
    .map((match) => ({
      ...match,
      linkPath: resolveVaultPathCandidate(this, match.path),
    }))
    .filter((match) => match.linkPath);

  if (!matches.length) return;

  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const match of matches) {
    const start = Math.max(cursor, Number(match.start) || 0);
    const end = Math.max(start, Number(match.end) || start);
    if (start > cursor) {
      fragment.appendChild(document.createTextNode(text.slice(cursor, start)));
    }
    const label = text.slice(start, end);
    fragment.appendChild(createVaultPathAnchor(match.linkPath, label, match.linkPath));
    cursor = end;
  }
  if (cursor < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(cursor)));
  }
  textNode.parentNode.replaceChild(fragment, textNode);
}

function enhancePlainTextVaultPathLinks(container) {
  if (!container || typeof document === "undefined" || typeof document.createTreeWalker !== "function") return;
  const showText = typeof NodeFilter !== "undefined" && NodeFilter ? NodeFilter.SHOW_TEXT : 4;
  const walker = document.createTreeWalker(container, showText);
  const nodes = [];
  let node = walker.nextNode();
  while (node) {
    nodes.push(node);
    node = walker.nextNode();
  }
  nodes.forEach((textNode) => {
    this.enhanceTextNodeVaultPathLinks(textNode);
  });
}

function enhanceVaultPathLinks(container) {
  if (!container || typeof document === "undefined") return;
  this.enhanceInlineCodeVaultPathLinks(container);
  this.enhancePlainTextVaultPathLinks(container);
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
      this.enhanceVaultPathLinks(container);
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
      this.enhanceVaultPathLinks(container);
      this.attachInternalLinkHandlers(container);
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
  enhanceInlineCodeVaultPathLinks,
  enhancePlainTextVaultPathLinks,
  enhanceTextNodeVaultPathLinks,
  enhanceVaultPathLinks,
  getMarkdownRenderSourcePath,
  resolveInternalLinkText,
  renderMarkdownSafely,
  enhanceCodeBlocks,
};

module.exports = {
  MARKDOWN_RENDER_STATE,
  markdownMethods,
};

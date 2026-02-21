const { Notice, MarkdownRenderer } = require("obsidian");
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

function ensureCodeLanguageLabel(wrapper, codeEl, codeText) {
  if (!wrapper || !codeEl) return;
  const match = String(codeEl.className || "").match(/language-([A-Za-z0-9_+-]+)/);
  const hasLanguage = Boolean(match && match[1]);
  wrapper.classList.toggle("has-language", hasLanguage);

  let labelBtn = wrapper.querySelector(".oc-code-lang-label");
  if (!hasLanguage) {
    if (labelBtn) labelBtn.remove();
    return;
  }

  const language = String(match[1] || "").toLowerCase();
  if (!labelBtn) {
    labelBtn = document.createElement("button");
    labelBtn.className = "oc-code-lang-label";
    labelBtn.type = "button";
    labelBtn.setAttribute("aria-label", `复制 ${language} 代码`);
    wrapper.appendChild(labelBtn);
  }

  labelBtn.textContent = language;
  labelBtn.onclick = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await copyTextToClipboard(codeText || "");
      showCopyFeedback(labelBtn, () => {
        labelBtn.textContent = language;
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

    ensureCodeLanguageLabel(wrapper, codeEl, codeText);
    ensureCodeCopyButton(wrapper, codeText);

    const obsidianCopy = wrapper.querySelector(".copy-code-button");
    if (obsidianCopy) obsidianCopy.remove();
  });
}

function attachCodeCopyButtons(container) {
  this.enhanceCodeBlocks(container);
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
  MarkdownRenderer.render(this.app, text, staging, "", this.plugin)
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
      if (typeof onRendered === "function") onRendered();
      this.scheduleScrollMessagesToBottom();
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
      this.scheduleScrollMessagesToBottom();
    });
}


const markdownMethods = {
  attachCodeCopyButtons,
  renderMarkdownSafely,
  enhanceCodeBlocks,
};

module.exports = {
  MARKDOWN_RENDER_STATE,
  markdownMethods,
};

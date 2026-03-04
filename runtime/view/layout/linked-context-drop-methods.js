const { Notice } = require("obsidian");
const {
  LINKED_CONTEXT_MAX_FILES,
  tr,
  normalizeLinkedContextPath,
  isLinkableContextFile,
  isLinkableContextFolder,
} = require("./shared-utils");

const LINKED_CONTEXT_DROP_TEXT_TYPES = [
  "text/plain",
  "text/uri-list",
];
const LINKED_CONTEXT_DROP_EXTENSION_CANDIDATES = ["md", "canvas", "txt", "json", "csv", "yaml", "yml"];

function isLinkableContextTarget(target) {
  return isLinkableContextFile(target) || isLinkableContextFolder(target);
}

function toggleElementClass(el, className, enabled) {
  if (!el || !className) return;
  if (typeof el.toggleClass === "function") {
    el.toggleClass(className, Boolean(enabled));
    return;
  }
  if (el.classList && typeof el.classList.toggle === "function") {
    el.classList.toggle(className, Boolean(enabled));
  }
}

function normalizeComparablePath(pathValue) {
  const normalized = String(pathValue || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function splitDropTextTokens(rawText) {
  return String(rawText || "")
    .split(/\r?\n+/)
    .map((token) => String(token || "").trim())
    .filter(Boolean)
    .map((token) => token.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

function extractWikiLinkTargets(rawText) {
  const text = String(rawText || "");
  const targets = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let match = re.exec(text);
  while (match) {
    targets.push(String(match[1] || "").trim());
    match = re.exec(text);
  }
  return targets;
}

function extractPathFromObsidianUri(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value || !/^obsidian:\/\//i.test(value)) return "";
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "obsidian:") return "";
    const fromQuery = [
      parsed.searchParams.get("file"),
      parsed.searchParams.get("path"),
      parsed.searchParams.get("url"),
      parsed.searchParams.get("name"),
    ].map((item) => String(item || "").trim()).find(Boolean);
    if (fromQuery) return fromQuery;
    const pathname = String(parsed.pathname || "").trim().replace(/^\/+/, "");
    if (pathname) return pathname;
    return "";
  } catch {
    const match = value.match(/[?&](?:file|path|url|name)=([^&#]+)/i);
    if (match && match[1]) {
      return String(match[1] || "").trim();
    }
    return "";
  }
}

function decodeMaybe(value) {
  const text = String(value || "");
  if (!text) return "";
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function normalizeDropCandidateToken(rawToken) {
  let token = String(rawToken || "").trim();
  if (!token) return "";
  if (token.startsWith("<") && token.endsWith(">")) {
    token = token.slice(1, -1).trim();
  }
  token = token.replace(/^['"]+|['"]+$/g, "").trim();
  if (!token) return "";
  token = token.replace(/\\#/g, "#").replace(/\\\|/g, "|");
  if (token.includes("|")) token = token.split("|")[0];
  if (token.includes("#")) token = token.split("#")[0];
  return token.trim();
}

function pushUniqueString(list, seen, value) {
  const text = String(value || "").trim();
  if (!text || seen.has(text)) return;
  seen.add(text);
  list.push(text);
}

function hasFileExtension(pathValue) {
  const path = String(pathValue || "").trim();
  if (!path) return false;
  const slashIndex = path.lastIndexOf("/");
  const filename = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
  return /\.[A-Za-z0-9_-]+$/.test(filename);
}

function buildPathResolutionCandidates(view, rawPath) {
  const out = [];
  const seen = new Set();
  const base = String(rawPath || "").trim();
  if (!base) return out;

  pushUniqueString(out, seen, normalizeLinkedContextPath(base));
  pushUniqueString(out, seen, normalizeLinkedContextPath(decodeMaybe(base)));
  pushUniqueString(out, seen, normalizeLinkedContextPath(base.replace(/\\/g, "/")));
  pushUniqueString(out, seen, normalizeLinkedContextPath(decodeMaybe(base.replace(/\\/g, "/"))));

  const vault = view && view.app && view.app.vault;
  const vaultName = vault && typeof vault.getName === "function"
    ? String(vault.getName() || "").trim()
    : "";
  if (vaultName) {
    const lowerVault = vaultName.toLowerCase();
    out.slice().forEach((candidate) => {
      const lowerCandidate = candidate.toLowerCase();
      if (!lowerCandidate.startsWith(`${lowerVault}/`)) return;
      pushUniqueString(out, seen, candidate.slice(vaultName.length + 1));
    });
  }

  out.slice().forEach((candidate) => {
    if (hasFileExtension(candidate)) return;
    LINKED_CONTEXT_DROP_EXTENSION_CANDIDATES.forEach((ext) => {
      pushUniqueString(out, seen, `${candidate}.${ext}`);
    });
  });

  return out;
}

function normalizeMatchingKey(value) {
  return String(value || "")
    .normalize("NFC")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
}

function removeKnownExtension(pathValue) {
  const path = normalizeMatchingKey(pathValue);
  if (!path) return "";
  const slashIndex = path.lastIndexOf("/");
  const head = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : "";
  const tail = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
  const dotIndex = tail.lastIndexOf(".");
  if (dotIndex <= 0) return path;
  const ext = tail.slice(dotIndex + 1).toLowerCase();
  if (!LINKED_CONTEXT_DROP_EXTENSION_CANDIDATES.includes(ext)) return path;
  return `${head}${tail.slice(0, dotIndex)}`;
}

function resolveByLinkpathScan(view, rawPath) {
  const vault = view && view.app && view.app.vault;
  if (!vault || typeof vault.getFiles !== "function") return "";
  const metadataCache = view && view.app && view.app.metadataCache;
  const sourcePath = (() => {
    const workspace = view && view.app && view.app.workspace;
    const activeFile = workspace && typeof workspace.getActiveFile === "function"
      ? workspace.getActiveFile()
      : null;
    return String(activeFile && activeFile.path ? activeFile.path : "");
  })();

  const target = normalizeMatchingKey(rawPath);
  if (!target) return "";
  const targetNoExt = removeKnownExtension(target);
  const targetLower = target.toLowerCase();
  const targetNoExtLower = targetNoExt.toLowerCase();

  const files = vault.getFiles().filter((file) => isLinkableContextFile(file));
  const exactPath = [];
  const pathWithoutExt = [];
  const linktextExact = [];

  files.forEach((file) => {
    const filePath = normalizeMatchingKey(file.path || "");
    if (!filePath) return;
    if (filePath.toLowerCase() === targetLower) {
      exactPath.push(filePath);
      return;
    }
    if (removeKnownExtension(filePath).toLowerCase() === targetNoExtLower) {
      pathWithoutExt.push(filePath);
      return;
    }
    if (metadataCache && typeof metadataCache.fileToLinktext === "function") {
      const linktext = normalizeMatchingKey(metadataCache.fileToLinktext(file, sourcePath, true));
      if (linktext && linktext.toLowerCase() === targetLower) {
        linktextExact.push(filePath);
      }
    }
  });

  const pickUnique = (items) => (items.length === 1 ? normalizeLinkedContextPath(items[0]) : "");
  return pickUnique(exactPath) || pickUnique(pathWithoutExt) || pickUnique(linktextExact);
}

function resolveAbsolutePathToVaultPath(view, absolutePath) {
  const vault = view && view.app && view.app.vault;
  const adapter = vault && vault.adapter;
  const getBasePath = adapter && typeof adapter.getBasePath === "function"
    ? adapter.getBasePath.bind(adapter)
    : null;
  if (!getBasePath) return "";

  const basePath = normalizeComparablePath(getBasePath());
  const inputPath = normalizeComparablePath(absolutePath);
  if (!basePath || !inputPath) return "";

  const baseLower = basePath.toLowerCase();
  const inputLower = inputPath.toLowerCase();
  const prefix = `${baseLower}/`;
  if (!inputLower.startsWith(prefix)) return "";

  const relative = inputPath.slice(basePath.length + 1);
  return normalizeLinkedContextPath(relative);
}

function resolveDropTokenToLinkablePath(rawToken) {
  const vault = this.app && this.app.vault;
  if (!vault || typeof vault.getAbstractFileByPath !== "function") return "";

  const tryResolveByPath = (pathValue) => {
    const normalized = normalizeLinkedContextPath(pathValue);
    if (!normalized) return "";
    const target = vault.getAbstractFileByPath(normalized);
    if (!isLinkableContextTarget(target)) return "";
    return normalizeLinkedContextPath(target.path || normalized);
  };

  const token = normalizeDropCandidateToken(rawToken);
  if (!token) return "";
  const decodedToken = decodeMaybe(token);

  const directCandidates = buildPathResolutionCandidates(this, token);
  for (const candidate of directCandidates) {
    const directPath = tryResolveByPath(candidate);
    if (directPath) return directPath;
  }

  if (/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(decodedToken)) {
    const relative = resolveAbsolutePathToVaultPath(this, decodedToken);
    const relativeCandidates = buildPathResolutionCandidates(this, relative);
    for (const candidate of relativeCandidates) {
      const relativePath = tryResolveByPath(candidate);
      if (relativePath) return relativePath;
    }
  }

  const metadataCache = this.app && this.app.metadataCache;
  if (metadataCache && typeof metadataCache.getFirstLinkpathDest === "function") {
    const workspace = this.app && this.app.workspace;
    const activeFile = workspace && typeof workspace.getActiveFile === "function"
      ? workspace.getActiveFile()
      : null;
    const sourcePath = String(activeFile && activeFile.path ? activeFile.path : "");
    const linkpathCandidates = buildPathResolutionCandidates(this, decodedToken);
    for (const linkpath of linkpathCandidates) {
      const resolved = metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
      if (!isLinkableContextTarget(resolved)) continue;
      return normalizeLinkedContextPath(resolved.path);
    }
  }

  const scanned = resolveByLinkpathScan(this, decodedToken);
  if (scanned) return scanned;

  return "";
}

function collectDropCandidateTokens(dataTransfer) {
  const rawTokens = [];
  const rawSeen = new Set();
  const pushRaw = (value) => {
    const token = String(value || "").trim();
    if (!token || rawSeen.has(token)) return;
    rawSeen.add(token);
    rawTokens.push(token);
  };

  const fileList = dataTransfer && dataTransfer.files
    ? Array.from(dataTransfer.files)
    : [];
  fileList.forEach((file) => {
    if (!file || typeof file !== "object") return;
    pushRaw(file.path);
    pushRaw(file.name);
  });

  LINKED_CONTEXT_DROP_TEXT_TYPES.forEach((type) => {
    let value = "";
    try {
      value = dataTransfer.getData(type);
    } catch {
      value = "";
    }
    pushRaw(value);
  });

  const types = dataTransfer && dataTransfer.types
    ? Array.from(dataTransfer.types)
    : [];
  types
    .filter((type) => /obsidian/i.test(String(type || "")))
    .forEach((type) => {
      let value = "";
      try {
        value = dataTransfer.getData(type);
      } catch {
        value = "";
      }
      pushRaw(value);
    });

  const expanded = [];
  const expandedSeen = new Set();
  const pushExpanded = (value) => {
    const token = String(value || "").trim();
    if (!token || expandedSeen.has(token)) return;
    expandedSeen.add(token);
    expanded.push(token);
  };

  rawTokens.forEach((rawToken) => {
    pushExpanded(rawToken);
    splitDropTextTokens(rawToken).forEach((token) => pushExpanded(token));
    extractWikiLinkTargets(rawToken).forEach((token) => pushExpanded(token));
    pushExpanded(extractPathFromObsidianUri(rawToken));
  });

  return expanded;
}

function extractLinkedContextPathsFromDropEvent(event) {
  const dataTransfer = event && event.dataTransfer;
  if (!dataTransfer) return [];
  const tokens = collectDropCandidateTokens(dataTransfer);
  if (!tokens.length) return [];
  const resolved = [];
  const seen = new Set();
  tokens.forEach((token) => {
    const next = resolveDropTokenToLinkablePath.call(this, token);
    if (!next || seen.has(next)) return;
    seen.add(next);
    resolved.push(next);
  });
  return resolved;
}

function looksLikeLinkedContextDropEvent(event) {
  const dataTransfer = event && event.dataTransfer;
  if (!dataTransfer) return false;

  const fileList = dataTransfer.files ? Array.from(dataTransfer.files) : [];
  if (fileList.length > 0) return true;

  const types = dataTransfer.types ? Array.from(dataTransfer.types).map((type) => String(type || "").toLowerCase()) : [];
  if (types.some((type) => type.includes("obsidian"))) return true;
  if (types.includes("text/uri-list")) {
    let uriList = "";
    try {
      uriList = String(dataTransfer.getData("text/uri-list") || "");
    } catch {
      uriList = "";
    }
    if (/^obsidian:\/\//i.test(uriList.trim()) || /^file:\/\//i.test(uriList.trim())) return true;
  }

  let textPlain = "";
  try {
    textPlain = String(dataTransfer.getData("text/plain") || "");
  } catch {
    textPlain = "";
  }
  return /^obsidian:\/\//i.test(textPlain.trim()) || /^file:\/\//i.test(textPlain.trim());
}

function setLinkedContextDropActive(isActive) {
  const inputWrapper = this.elements && this.elements.inputWrapper;
  toggleElementClass(inputWrapper, "is-drop-target", Boolean(isActive));
}

function handleLinkedContextInputDragOver(event) {
  const droppedPaths = this.extractLinkedContextPathsFromDropEvent(event);
  const shouldHandle = droppedPaths.length > 0 || looksLikeLinkedContextDropEvent(event);
  if (!shouldHandle) {
    this.setLinkedContextDropActive(false);
    return false;
  }
  event.preventDefault();
  if (event.dataTransfer) {
    try {
      event.dataTransfer.dropEffect = "copy";
    } catch {
    }
  }
  this.setLinkedContextDropActive(true);
  return true;
}

function handleLinkedContextInputDragLeave(event) {
  const currentTarget = event && event.currentTarget;
  const relatedTarget = event && event.relatedTarget;
  if (currentTarget && relatedTarget && typeof currentTarget.contains === "function" && currentTarget.contains(relatedTarget)) {
    return false;
  }
  this.setLinkedContextDropActive(false);
  return true;
}

function handleLinkedContextInputDrop(event) {
  const droppedPaths = this.extractLinkedContextPathsFromDropEvent(event);
  const shouldHandle = droppedPaths.length > 0 || looksLikeLinkedContextDropEvent(event);
  this.setLinkedContextDropActive(false);
  if (!shouldHandle) return false;

  event.preventDefault();
  event.stopPropagation();

  if (!droppedPaths.length) {
    new Notice(tr(this, "view.context.dropUnsupported", "Unable to link dropped file automatically. Please try selecting it with @."));
    const inputEl = this.elements && this.elements.input;
    if (inputEl && typeof inputEl.focus === "function") {
      inputEl.focus();
    }
    return true;
  }

  const linkedPaths = this.getLinkedContextFilePaths().slice();
  const linkedSet = new Set(linkedPaths);
  let added = 0;
  let skippedByLimit = 0;
  droppedPaths.forEach((pathValue) => {
    if (!pathValue || linkedSet.has(pathValue)) return;
    if (linkedPaths.length >= LINKED_CONTEXT_MAX_FILES) {
      skippedByLimit += 1;
      return;
    }
    linkedPaths.push(pathValue);
    linkedSet.add(pathValue);
    added += 1;
  });

  if (added > 0) {
    this.linkedContextFiles = linkedPaths;
    this.refreshLinkedContextIndicators();
  }

  if (skippedByLimit > 0) {
    new Notice(tr(this, "view.context.maxFiles", "You can link up to {count} context items at once.", {
      count: LINKED_CONTEXT_MAX_FILES,
    }));
  }

  const inputEl = this.elements && this.elements.input;
  if (inputEl && typeof inputEl.focus === "function") {
    inputEl.focus();
  }
  return true;
}

const linkedContextDropMethods = {
  extractLinkedContextPathsFromDropEvent,
  setLinkedContextDropActive,
  handleLinkedContextInputDragOver,
  handleLinkedContextInputDragLeave,
  handleLinkedContextInputDrop,
};

module.exports = { linkedContextDropMethods };

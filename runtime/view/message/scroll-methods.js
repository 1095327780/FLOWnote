const AUTO_SCROLL_REENABLE_THRESHOLD = 24;
const AUTO_SCROLL_STICKY_THRESHOLD = 120;
const PROGRAMMATIC_SCROLL_SUPPRESS_MS = 140;
const FORCE_BOTTOM_MIN_MS = 0;
const FORCE_BOTTOM_DEFAULT_MS = 0;
const MANUAL_INTENT_WINDOW_MS = 1200;

function isMessagesNearBottom(threshold = AUTO_SCROLL_REENABLE_THRESHOLD) {
  const container = this.elements && this.elements.messages;
  if (!container) return true;
  const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
  return distance <= Math.max(0, Number(threshold) || 0);
}

function normalizeForceBottomMs(durationMs) {
  const raw = Number(durationMs);
  if (!Number.isFinite(raw) || raw <= FORCE_BOTTOM_MIN_MS) return FORCE_BOTTOM_DEFAULT_MS;
  return Math.max(FORCE_BOTTOM_MIN_MS, Math.floor(raw));
}

function setForceBottomWindow(durationMs = FORCE_BOTTOM_DEFAULT_MS) {
  const ms = normalizeForceBottomMs(durationMs);
  this.forceBottomUntil = ms > 0 ? Date.now() + ms : 0;
}

function hasActiveForceBottom() {
  const until = Number(this.forceBottomUntil || 0);
  if (until <= Date.now()) {
    this.forceBottomUntil = 0;
    return false;
  }
  return true;
}

function markManualScrollIntent() {
  this.lastManualScrollIntentAt = Date.now();
}

function hasRecentManualScrollIntent(windowMs = MANUAL_INTENT_WINDOW_MS) {
  const last = Number(this.lastManualScrollIntentAt || 0);
  if (!last) return false;
  return (Date.now() - last) <= Math.max(0, Number(windowMs) || 0);
}

function suppressProgrammaticScrollEvents() {
  this.ignoreMessageScrollEventsUntil = Date.now() + PROGRAMMATIC_SCROLL_SUPPRESS_MS;
}

function withProgrammaticScroll(container, callback) {
  if (!container || typeof callback !== "function") return;
  this.suppressProgrammaticScrollEvents();
  callback();
  requestAnimationFrame(() => {
    this.suppressProgrammaticScrollEvents();
    this.autoScrollEnabled = this.isMessagesNearBottom(AUTO_SCROLL_STICKY_THRESHOLD);
  });
}

function shouldAutoScrollMessages() {
  if (this.hasActiveForceBottom()) return true;
  if (typeof this.autoScrollEnabled !== "boolean") return true;
  return this.autoScrollEnabled;
}

function bindMessagesScrollTracking() {
  const container = this.elements && this.elements.messages;
  if (!container) return;
  if (this.messagesScrollEl === container && typeof this.messagesScrollHandler === "function") return;

  this.unbindMessagesScrollTracking();
  const onManualIntent = () => {
    this.markManualScrollIntent();
  };
  const onKeyDown = (event) => {
    const key = String((event && event.key) || "");
    if (!key) return;
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(key)) {
      this.markManualScrollIntent();
    }
  };
  const onScroll = () => {
    const ignoreUntil = Number(this.ignoreMessageScrollEventsUntil || 0);
    if (ignoreUntil > Date.now()) return;
    const nearBottom = this.isMessagesNearBottom(AUTO_SCROLL_REENABLE_THRESHOLD);
    if (nearBottom) {
      this.autoScrollEnabled = true;
      return;
    }
    if (this.hasRecentManualScrollIntent()) {
      this.setForceBottomWindow(0);
      this.autoScrollEnabled = false;
      return;
    }
    if (!this.autoScrollEnabled) return;
    this.autoScrollEnabled = true;
  };
  container.addEventListener("wheel", onManualIntent, { passive: true });
  container.addEventListener("touchstart", onManualIntent, { passive: true });
  container.addEventListener("pointerdown", onManualIntent, { passive: true });
  container.addEventListener("keydown", onKeyDown);
  container.addEventListener("scroll", onScroll, { passive: true });
  this.messagesScrollEl = container;
  this.messagesScrollHandler = onScroll;
  this.messagesIntentHandler = onManualIntent;
  this.messagesKeyDownHandler = onKeyDown;
  this.autoScrollEnabled = this.isMessagesNearBottom(AUTO_SCROLL_STICKY_THRESHOLD);
}

function unbindMessagesScrollTracking() {
  if (this.messagesScrollEl && typeof this.messagesIntentHandler === "function") {
    this.messagesScrollEl.removeEventListener("wheel", this.messagesIntentHandler);
    this.messagesScrollEl.removeEventListener("touchstart", this.messagesIntentHandler);
    this.messagesScrollEl.removeEventListener("pointerdown", this.messagesIntentHandler);
  }
  if (this.messagesScrollEl && typeof this.messagesKeyDownHandler === "function") {
    this.messagesScrollEl.removeEventListener("keydown", this.messagesKeyDownHandler);
  }
  if (this.messagesScrollEl && typeof this.messagesScrollHandler === "function") {
    this.messagesScrollEl.removeEventListener("scroll", this.messagesScrollHandler);
  }
  this.messagesScrollEl = null;
  this.messagesScrollHandler = null;
  this.messagesIntentHandler = null;
  this.messagesKeyDownHandler = null;
  if (this.pendingScrollRaf) {
    cancelAnimationFrame(this.pendingScrollRaf);
    this.pendingScrollRaf = 0;
  }
}

function scheduleScrollMessagesToBottom(force = false) {
  const container = this.elements && this.elements.messages;
  if (!container) return;
  const shouldForce = Boolean(force || this.hasActiveForceBottom());
  if (shouldForce) this.autoScrollEnabled = true;
  if (!shouldForce && !this.shouldAutoScrollMessages()) return;
  if (this.pendingScrollRaf) cancelAnimationFrame(this.pendingScrollRaf);
  this.pendingScrollRaf = requestAnimationFrame(() => {
    this.pendingScrollRaf = 0;
    const latestContainer = this.elements && this.elements.messages;
    if (!latestContainer) return;
    const shouldForceNow = Boolean(force || this.hasActiveForceBottom());
    if (shouldForceNow) this.autoScrollEnabled = true;
    if (!shouldForceNow && !this.shouldAutoScrollMessages()) return;
    this.withProgrammaticScroll(latestContainer, () => {
      latestContainer.scrollTop = latestContainer.scrollHeight;
    });
  });
}


const scrollMethods = {
  isMessagesNearBottom,
  setForceBottomWindow,
  hasActiveForceBottom,
  markManualScrollIntent,
  hasRecentManualScrollIntent,
  suppressProgrammaticScrollEvents,
  withProgrammaticScroll,
  shouldAutoScrollMessages,
  bindMessagesScrollTracking,
  unbindMessagesScrollTracking,
  scheduleScrollMessagesToBottom,
};

module.exports = { scrollMethods };

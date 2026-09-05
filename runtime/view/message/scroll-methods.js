const AUTO_SCROLL_REENABLE_THRESHOLD = 24;
const AUTO_SCROLL_STICKY_THRESHOLD = 120;
const PROGRAMMATIC_SCROLL_SUPPRESS_MS = 140;
const FORCE_BOTTOM_MIN_MS = 0;
const FORCE_BOTTOM_DEFAULT_MS = 0;
const MANUAL_INTENT_WINDOW_MS = 1200;
const TOUCH_SCROLL_INERTIA_WINDOW_MS = 1200;

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
  if (this.touchScrollInProgress) return true;
  const touchInertiaUntil = Number(this.touchScrollInertiaUntil || 0);
  if (touchInertiaUntil > Date.now()) return true;
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

function mutateMessagesPreservingViewport(callback) {
  const container = this.elements && this.elements.messages;
  if (typeof callback !== "function") return;
  if (!container) {
    callback();
    return;
  }
  const shouldStickToBottom = this.shouldAutoScrollMessages();
  const previousScrollTop = Number(container.scrollTop || 0);
  callback();
  this.withProgrammaticScroll(container, () => {
    container.scrollLeft = 0;
    if (shouldStickToBottom) {
      container.scrollTop = container.scrollHeight;
      return;
    }
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = Math.max(0, Math.min(previousScrollTop, maxTop));
  });
}

function bindMessagesScrollTracking() {
  const container = this.elements && this.elements.messages;
  if (!container) return;
  if (this.messagesScrollEl === container && typeof this.messagesScrollHandler === "function") return;

  this.unbindMessagesScrollTracking();
  const onManualIntent = () => {
    this.markManualScrollIntent();
  };
  const onWheelIntent = () => {
    // A wheel event is unambiguous reader input. Let its accompanying scroll
    // event win over the short suppression window used for our own writes.
    this.ignoreMessageScrollEventsUntil = 0;
    this.markManualScrollIntent();
  };
  const onTouchStart = () => {
    // A tap also starts a touch sequence. Wait for movement before claiming
    // scroll ownership so tapping a message does not opt out of follow.
    this.touchScrollInProgress = false;
    this.touchScrollInertiaUntil = 0;
  };
  const onTouchMove = () => {
    this.touchScrollInProgress = true;
    this.ignoreMessageScrollEventsUntil = 0;
    this.markManualScrollIntent();
  };
  const onTouchEnd = () => {
    const wasScrolling = this.touchScrollInProgress;
    this.touchScrollInProgress = false;
    this.touchScrollInertiaUntil = wasScrolling ? Date.now() + TOUCH_SCROLL_INERTIA_WINDOW_MS : 0;
    if (wasScrolling) this.markManualScrollIntent();
  };
  const onKeyDown = (event) => {
    const key = String((event && event.key) || "");
    if (!key) return;
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(key)) {
      this.markManualScrollIntent();
    }
  };
  const onScroll = () => {
    if (Number(container.scrollLeft || 0) !== 0) container.scrollLeft = 0;
    const ignoreUntil = Number(this.ignoreMessageScrollEventsUntil || 0);
    if (ignoreUntil > Date.now()) return;
    const nearBottom = this.isMessagesNearBottom(AUTO_SCROLL_REENABLE_THRESHOLD);
    if (nearBottom) {
      if (this.autoScrollEnabled || this.hasRecentManualScrollIntent()) {
        this.autoScrollEnabled = true;
      }
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
  container.addEventListener("wheel", onWheelIntent, { passive: true });
  container.addEventListener("touchstart", onTouchStart, { passive: true });
  container.addEventListener("touchmove", onTouchMove, { passive: true });
  container.addEventListener("touchend", onTouchEnd, { passive: true });
  container.addEventListener("touchcancel", onTouchEnd, { passive: true });
  container.addEventListener("pointerdown", onManualIntent, { passive: true });
  container.addEventListener("keydown", onKeyDown);
  container.addEventListener("scroll", onScroll, { passive: true });
  this.messagesScrollEl = container;
  this.messagesScrollHandler = onScroll;
  this.messagesWheelIntentHandler = onWheelIntent;
  this.messagesPointerDownHandler = onManualIntent;
  this.messagesTouchStartHandler = onTouchStart;
  this.messagesTouchMoveHandler = onTouchMove;
  this.messagesTouchEndHandler = onTouchEnd;
  this.messagesKeyDownHandler = onKeyDown;
  this.autoScrollEnabled = this.isMessagesNearBottom(AUTO_SCROLL_STICKY_THRESHOLD);
}

function unbindMessagesScrollTracking() {
  if (this.messagesScrollEl && typeof this.messagesWheelIntentHandler === "function") {
    this.messagesScrollEl.removeEventListener("wheel", this.messagesWheelIntentHandler);
  }
  if (this.messagesScrollEl && typeof this.messagesPointerDownHandler === "function") {
    this.messagesScrollEl.removeEventListener("pointerdown", this.messagesPointerDownHandler);
  }
  if (this.messagesScrollEl && typeof this.messagesTouchStartHandler === "function") {
    this.messagesScrollEl.removeEventListener("touchstart", this.messagesTouchStartHandler);
  }
  if (this.messagesScrollEl && typeof this.messagesTouchMoveHandler === "function") {
    this.messagesScrollEl.removeEventListener("touchmove", this.messagesTouchMoveHandler);
  }
  if (this.messagesScrollEl && typeof this.messagesTouchEndHandler === "function") {
    this.messagesScrollEl.removeEventListener("touchend", this.messagesTouchEndHandler);
    this.messagesScrollEl.removeEventListener("touchcancel", this.messagesTouchEndHandler);
  }
  if (this.messagesScrollEl && typeof this.messagesKeyDownHandler === "function") {
    this.messagesScrollEl.removeEventListener("keydown", this.messagesKeyDownHandler);
  }
  if (this.messagesScrollEl && typeof this.messagesScrollHandler === "function") {
    this.messagesScrollEl.removeEventListener("scroll", this.messagesScrollHandler);
  }
  this.messagesScrollEl = null;
  this.messagesScrollHandler = null;
  this.messagesWheelIntentHandler = null;
  this.messagesPointerDownHandler = null;
  this.messagesTouchStartHandler = null;
  this.messagesTouchMoveHandler = null;
  this.messagesTouchEndHandler = null;
  this.messagesKeyDownHandler = null;
  this.touchScrollInProgress = false;
  this.touchScrollInertiaUntil = 0;
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
      latestContainer.scrollLeft = 0;
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
  mutateMessagesPreservingViewport,
  bindMessagesScrollTracking,
  unbindMessagesScrollTracking,
  scheduleScrollMessagesToBottom,
};

module.exports = { scrollMethods };

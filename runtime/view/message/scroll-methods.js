const AUTO_SCROLL_REENABLE_THRESHOLD = 24;
const AUTO_SCROLL_STICKY_THRESHOLD = 120;

function isMessagesNearBottom(threshold = AUTO_SCROLL_REENABLE_THRESHOLD) {
  const container = this.elements && this.elements.messages;
  if (!container) return true;
  const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
  return distance <= Math.max(0, Number(threshold) || 0);
}

function shouldAutoScrollMessages() {
  if (Boolean(this.autoScrollLock)) return true;
  if (typeof this.autoScrollEnabled !== "boolean") return true;
  return this.autoScrollEnabled;
}

function bindMessagesScrollTracking() {
  const container = this.elements && this.elements.messages;
  if (!container) return;
  if (this.messagesScrollEl === container && typeof this.messagesScrollHandler === "function") return;

  this.unbindMessagesScrollTracking();
  const onScroll = () => {
    const nearBottom = this.isMessagesNearBottom(AUTO_SCROLL_REENABLE_THRESHOLD);
    if (this.autoScrollLock && !nearBottom) {
      // User actively scrolled up: release send-time auto-follow lock.
      this.autoScrollLock = false;
    }
    if (nearBottom) {
      this.autoScrollEnabled = true;
      return;
    }
    this.autoScrollEnabled = false;
  };
  container.addEventListener("scroll", onScroll, { passive: true });
  this.messagesScrollEl = container;
  this.messagesScrollHandler = onScroll;
  this.autoScrollEnabled = this.autoScrollLock
    ? true
    : this.isMessagesNearBottom(AUTO_SCROLL_STICKY_THRESHOLD);
}

function unbindMessagesScrollTracking() {
  if (this.messagesScrollEl && typeof this.messagesScrollHandler === "function") {
    this.messagesScrollEl.removeEventListener("scroll", this.messagesScrollHandler);
  }
  this.messagesScrollEl = null;
  this.messagesScrollHandler = null;
  if (this.pendingScrollRaf) {
    cancelAnimationFrame(this.pendingScrollRaf);
    this.pendingScrollRaf = 0;
  }
}

function scheduleScrollMessagesToBottom(force = false) {
  const container = this.elements && this.elements.messages;
  if (!container) return;
  const shouldForce = Boolean(force || this.autoScrollLock);
  if (shouldForce) this.autoScrollEnabled = true;
  if (!shouldForce && !this.shouldAutoScrollMessages()) return;
  if (this.pendingScrollRaf) cancelAnimationFrame(this.pendingScrollRaf);
  this.pendingScrollRaf = requestAnimationFrame(() => {
    this.pendingScrollRaf = 0;
    const latestContainer = this.elements && this.elements.messages;
    if (!latestContainer) return;
    if (shouldForce) this.autoScrollEnabled = true;
    if (!shouldForce && !this.shouldAutoScrollMessages()) return;
    latestContainer.scrollTop = latestContainer.scrollHeight;
  });
}


const scrollMethods = {
  isMessagesNearBottom,
  shouldAutoScrollMessages,
  bindMessagesScrollTracking,
  unbindMessagesScrollTracking,
  scheduleScrollMessagesToBottom,
};

module.exports = { scrollMethods };

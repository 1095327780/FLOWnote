let inlineQuestionPanelSequence = 0;

class InlineAskUserQuestionPanel {
  constructor(containerEl, input, resolve, signal, config) {
    this.containerEl = containerEl;
    this.input = input || {};
    this.resolveCallback = typeof resolve === "function" ? resolve : () => {};
    this.signal = signal;
    this.resolved = false;
    this.config = {
      title: (config && config.title) || "FLOWnote has a question",
      headerEl: config && config.headerEl ? config.headerEl : null,
      showCustomInput: config && typeof config.showCustomInput === "boolean" ? config.showCustomInput : true,
      immediateSelect: config && typeof config.immediateSelect === "boolean" ? config.immediateSelect : false,
      copy: config && config.copy && typeof config.copy === "object" ? config.copy : {},
    };

    this.questions = [];
    this.answers = new Map();
    this.customInputs = new Map();
    this.activeTabIndex = 0;
    this.focusedItemIndex = 0;
    this.isInputFocused = false;
    this.rootEl = null;
    this.tabBar = null;
    this.contentArea = null;
    this.tabElements = [];
    this.currentItems = [];
    this.abortHandler = null;
    this.boundKeyDown = this.handleKeyDown.bind(this);
    inlineQuestionPanelSequence += 1;
    this.panelId = `flownote-inline-question-${inlineQuestionPanelSequence}`;
  }

  render() {
    this.rootEl = this.containerEl.createDiv({ cls: "claudian-ask-question-inline" });
    this.rootEl.toggleClass("is-immediate", Boolean(this.config.immediateSelect));

    const titleEl = this.rootEl.createDiv({ cls: "claudian-ask-inline-title" });
    titleEl.setText(this.config.title);

    if (this.config.headerEl) {
      this.rootEl.appendChild(this.config.headerEl);
    }

    this.questions = this.parseQuestions();
    if (!this.questions.length) {
      this.handleResolve(null);
      return;
    }

    if (this.config.immediateSelect && (this.questions.length !== 1 || !Array.isArray(this.questions[0].options) || !this.questions[0].options.length)) {
      this.config.immediateSelect = false;
    }

    for (let i = 0; i < this.questions.length; i += 1) {
      this.answers.set(i, new Set());
      this.customInputs.set(i, "");
    }

    if (!this.config.immediateSelect) {
      this.tabBar = this.rootEl.createDiv({
        cls: "claudian-ask-tab-bar",
        attr: { role: "tablist", "aria-label": this.config.title },
      });
      this.renderTabBar();
    }
    const contentAttrs = {
      id: `${this.panelId}-panel`,
      role: this.config.immediateSelect ? "group" : "tabpanel",
    };
    if (this.config.immediateSelect) contentAttrs["aria-label"] = this.config.title;
    this.contentArea = this.rootEl.createDiv({ cls: "claudian-ask-content", attr: contentAttrs });
    this.renderTabContent();

    this.rootEl.setAttribute("tabindex", "0");
    this.rootEl.addEventListener("keydown", this.boundKeyDown);

    requestAnimationFrame(() => {
      if (!this.rootEl) return;
      const focusTarget = this.config.immediateSelect
        ? this.rootEl
        : this.tabElements[this.activeTabIndex];
      if (focusTarget && typeof focusTarget.focus === "function") focusTarget.focus();
      this.rootEl.scrollIntoView({ block: "nearest", behavior: this.prefersReducedMotion() ? "auto" : "smooth" });
    });

    if (this.signal) {
      this.abortHandler = () => this.handleResolve(null);
      this.signal.addEventListener("abort", this.abortHandler, { once: true });
    }
  }

  copy(key, fallback) {
    const value = this.config.copy && this.config.copy[key];
    return typeof value === "string" && value.trim() ? value : fallback;
  }

  prefersReducedMotion() {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  destroy(silent = false) {
    if (silent) {
      if (this.resolved) return;
      this.resolved = true;
      if (this.rootEl) this.rootEl.removeEventListener("keydown", this.boundKeyDown);
      if (this.signal && this.abortHandler) {
        this.signal.removeEventListener("abort", this.abortHandler);
        this.abortHandler = null;
      }
      if (this.rootEl) this.rootEl.remove();
      return;
    }
    this.handleResolve(null);
  }

  parseQuestions() {
    const raw = this.input && Array.isArray(this.input.questions) ? this.input.questions : [];
    return raw
      .filter((q) => (
        q &&
        typeof q === "object" &&
        typeof q.question === "string"
      ))
      .map((q, idx) => ({
        question: String(q.question || ""),
        header: typeof q.header === "string" ? q.header.slice(0, 12) : `Q${idx + 1}`,
        options: this.deduplicateOptions((Array.isArray(q.options) ? q.options : []).map((o) => this.coerceOption(o))),
        multiSelect: Boolean(q.multiSelect),
      }))
      .filter((q) => String(q.question || "").trim().length > 0);
  }

  coerceOption(opt) {
    if (opt && typeof opt === "object") {
      const obj = opt;
      const label = this.extractLabel(obj);
      const description = typeof obj.description === "string" ? obj.description : "";
      return { label, description };
    }
    return { label: typeof opt === "string" ? opt : String(opt), description: "" };
  }

  deduplicateOptions(options) {
    const seen = new Set();
    return options.filter((o) => {
      if (!o || typeof o.label !== "string") return false;
      const label = o.label.trim();
      if (!label) return false;
      if (seen.has(label)) return false;
      seen.add(label);
      o.label = label;
      return true;
    });
  }

  extractLabel(obj) {
    if (typeof obj.label === "string") return obj.label;
    if (typeof obj.value === "string") return obj.value;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.name === "string") return obj.name;
    return String(obj);
  }

  renderTabBar() {
    if (!this.tabBar) return;
    this.tabBar.empty();
    this.tabElements = [];

    for (let idx = 0; idx < this.questions.length; idx += 1) {
      const answered = this.isQuestionAnswered(idx);
      const tab = this.tabBar.createEl("button", {
        cls: "claudian-ask-tab",
        attr: {
          id: `${this.panelId}-tab-${idx}`,
          type: "button",
          role: "tab",
          tabindex: idx === this.activeTabIndex ? "0" : "-1",
          "aria-controls": `${this.panelId}-panel`,
          "aria-selected": idx === this.activeTabIndex ? "true" : "false",
        },
      });
      tab.createSpan({ text: this.questions[idx].header, cls: "claudian-ask-tab-label" });
      tab.createSpan({ text: answered ? " ✓" : "", cls: "claudian-ask-tab-tick" });
      tab.setAttribute("title", this.questions[idx].question);
      if (idx === this.activeTabIndex) tab.addClass("is-active");
      if (answered) tab.addClass("is-answered");
      tab.addEventListener("click", () => this.switchTab(idx));
      tab.addEventListener("keydown", (event) => this.handleTabKeyDown(event, idx));
      this.tabElements.push(tab);
    }

    const allAnswered = this.questions.every((_, i) => this.isQuestionAnswered(i));
    const submitTab = this.tabBar.createEl("button", {
      cls: "claudian-ask-tab",
      attr: {
        id: `${this.panelId}-tab-${this.questions.length}`,
        type: "button",
        role: "tab",
        tabindex: this.activeTabIndex === this.questions.length ? "0" : "-1",
        "aria-controls": `${this.panelId}-panel`,
        "aria-selected": this.activeTabIndex === this.questions.length ? "true" : "false",
      },
    });
    submitTab.createSpan({ text: allAnswered ? "✓ " : "", cls: "claudian-ask-tab-submit-check" });
    submitTab.createSpan({ text: this.copy("submit", "Submit"), cls: "claudian-ask-tab-label" });
    if (this.activeTabIndex === this.questions.length) submitTab.addClass("is-active");
    submitTab.addEventListener("click", () => this.switchTab(this.questions.length));
    submitTab.addEventListener("keydown", (event) => this.handleTabKeyDown(event, this.questions.length));
    this.tabElements.push(submitTab);
  }

  isQuestionAnswered(idx) {
    return this.answers.get(idx).size > 0 || this.customInputs.get(idx).trim().length > 0;
  }

  switchTab(index) {
    const clamped = Math.max(0, Math.min(index, this.questions.length));
    if (clamped === this.activeTabIndex) return;
    this.activeTabIndex = clamped;
    this.focusedItemIndex = 0;
    this.isInputFocused = false;
    if (!this.config.immediateSelect) this.renderTabBar();
    this.renderTabContent();
    const focusTarget = this.config.immediateSelect
      ? this.rootEl
      : this.tabElements[clamped];
    if (focusTarget && typeof focusTarget.focus === "function") focusTarget.focus();
  }

  handleTabKeyDown(event, index) {
    const tabCount = this.questions.length + 1;
    if (!tabCount) return false;
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabCount;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabCount) % tabCount;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabCount - 1;
    else return false;
    event.preventDefault();
    event.stopPropagation();
    this.switchTab(nextIndex);
    return true;
  }

  renderTabContent() {
    if (!this.contentArea) return;
    this.contentArea.empty();
    if (!this.config.immediateSelect) {
      this.contentArea.setAttribute("aria-labelledby", `${this.panelId}-tab-${this.activeTabIndex}`);
    } else {
      this.contentArea.removeAttribute("aria-labelledby");
    }
    this.currentItems = [];
    if (this.activeTabIndex < this.questions.length) {
      this.renderQuestionTab(this.activeTabIndex);
    } else {
      this.renderSubmitTab();
    }
  }

  renderQuestionTab(idx) {
    const q = this.questions[idx];
    const isMulti = q.multiSelect;
    const selected = this.answers.get(idx);

    const questionId = `${this.panelId}-question-${idx}`;
    this.contentArea.createDiv({
      text: q.question,
      cls: "claudian-ask-question-text",
      attr: { id: questionId },
    });

    const listEl = this.contentArea.createDiv({
      cls: "claudian-ask-list",
      attr: { role: isMulti ? "group" : "radiogroup", "aria-labelledby": questionId },
    });
    for (let optIdx = 0; optIdx < q.options.length; optIdx += 1) {
      const option = q.options[optIdx];
      const isFocused = optIdx === this.focusedItemIndex;
      const isSelected = selected.has(option.label);

      const row = listEl.createEl("button", { cls: "claudian-ask-item", attr: { type: "button", role: isMulti ? "checkbox" : "radio", "aria-checked": isSelected ? "true" : "false" } });
      if (isFocused) row.addClass("is-focused");
      if (isSelected) row.addClass("is-selected");

      row.createSpan({ text: isFocused ? "›" : " ", cls: "claudian-ask-cursor" });
      row.createSpan({ text: `${optIdx + 1}. `, cls: "claudian-ask-item-num" });
      if (isMulti) this.renderMultiSelectCheckbox(row, isSelected);

      const labelBlock = row.createDiv({ cls: "claudian-ask-item-content" });
      const labelRow = labelBlock.createDiv({ cls: "claudian-ask-label-row" });
      labelRow.createSpan({ text: option.label, cls: "claudian-ask-item-label" });
      if (!isMulti && isSelected) {
        labelRow.createSpan({ text: " ✓", cls: "claudian-ask-check-mark" });
      }
      if (option.description) {
        labelBlock.createDiv({ text: option.description, cls: "claudian-ask-item-desc" });
      }

      row.addEventListener("click", () => {
        this.focusedItemIndex = optIdx;
        this.updateFocusIndicator();
        this.selectOption(idx, option.label);
      });
      this.currentItems.push(row);
    }

    if (this.config.showCustomInput) {
      const customIdx = q.options.length;
      const customFocused = customIdx === this.focusedItemIndex;
      const customText = this.customInputs.get(idx) || "";
      const hasCustomText = customText.trim().length > 0;

      const customRow = listEl.createDiv({ cls: "claudian-ask-item claudian-ask-custom-item" });
      if (customFocused) customRow.addClass("is-focused");
      customRow.createSpan({ text: customFocused ? "›" : " ", cls: "claudian-ask-cursor" });
      customRow.createSpan({ text: `${customIdx + 1}. `, cls: "claudian-ask-item-num" });
      if (isMulti) this.renderMultiSelectCheckbox(customRow, hasCustomText);

      const inputEl = customRow.createEl("input", {
        type: "text",
        cls: "claudian-ask-custom-text",
        placeholder: this.copy("customPlaceholder", "Type something."),
        value: customText,
      });
      inputEl.addEventListener("input", () => {
        this.customInputs.set(idx, inputEl.value);
        if (!isMulti && inputEl.value.trim()) {
          selected.clear();
          this.updateOptionVisuals(idx);
        }
        this.updateTabIndicators();
      });
      inputEl.addEventListener("focus", () => {
        this.isInputFocused = true;
      });
      inputEl.addEventListener("blur", () => {
        this.isInputFocused = false;
      });
      this.currentItems.push(customRow);
    }

    this.contentArea.createDiv({
      text: this.config.immediateSelect ? this.copy("hintImmediate", "Choose an option, or press Esc to cancel") : this.copy("hint", "Choose an option, or use Tab/arrow keys to navigate"),
      cls: "claudian-ask-hints",
    });
  }

  renderSubmitTab() {
    this.contentArea.createDiv({
      text: this.copy("reviewTitle", "Review your answers"),
      cls: "claudian-ask-review-title",
    });

    const reviewEl = this.contentArea.createDiv({ cls: "claudian-ask-review" });
    for (let idx = 0; idx < this.questions.length; idx += 1) {
      const q = this.questions[idx];
      const answerText = this.getAnswerText(idx);

      const pairEl = reviewEl.createEl("button", {
        cls: "claudian-ask-review-pair",
        attr: { type: "button" },
      });
      pairEl.createSpan({ text: `${idx + 1}.`, cls: "claudian-ask-review-num" });
      const bodyEl = pairEl.createSpan({ cls: "claudian-ask-review-body" });
      bodyEl.createSpan({ text: q.question, cls: "claudian-ask-review-q-text" });
      bodyEl.createSpan({
        text: answerText || this.copy("notAnswered", "Not answered"),
        cls: answerText ? "claudian-ask-review-a-text" : "claudian-ask-review-empty",
      });
      pairEl.addEventListener("click", () => this.switchTab(idx));
    }

    this.contentArea.createDiv({
      text: this.copy("reviewPrompt", "Ready to submit your answers?"),
      cls: "claudian-ask-review-prompt",
    });

    const actionsEl = this.contentArea.createDiv({ cls: "claudian-ask-list" });
    const allAnswered = this.questions.every((_, i) => this.isQuestionAnswered(i));

    const submitRow = actionsEl.createEl("button", { cls: "claudian-ask-item", attr: { type: "button", disabled: allAnswered ? undefined : "true" } });
    if (this.focusedItemIndex === 0) submitRow.addClass("is-focused");
    if (!allAnswered) submitRow.addClass("is-disabled");
    submitRow.createSpan({ text: this.focusedItemIndex === 0 ? "›" : " ", cls: "claudian-ask-cursor" });
    submitRow.createSpan({ text: "1. ", cls: "claudian-ask-item-num" });
    submitRow.createSpan({ text: this.copy("submitAnswers", "Submit answers"), cls: "claudian-ask-item-label" });
    submitRow.addEventListener("click", () => {
      this.focusedItemIndex = 0;
      this.updateFocusIndicator();
      this.handleSubmit();
    });
    this.currentItems.push(submitRow);

    const cancelRow = actionsEl.createEl("button", { cls: "claudian-ask-item", attr: { type: "button" } });
    if (this.focusedItemIndex === 1) cancelRow.addClass("is-focused");
    cancelRow.createSpan({ text: this.focusedItemIndex === 1 ? "›" : " ", cls: "claudian-ask-cursor" });
    cancelRow.createSpan({ text: "2. ", cls: "claudian-ask-item-num" });
    cancelRow.createSpan({ text: this.copy("cancel", "Cancel"), cls: "claudian-ask-item-label" });
    cancelRow.addEventListener("click", () => {
      this.focusedItemIndex = 1;
      this.handleResolve(null);
    });
    this.currentItems.push(cancelRow);

    this.contentArea.createDiv({
      text: this.copy("hint", "Choose an option, or use Tab/arrow keys to navigate"),
      cls: "claudian-ask-hints",
    });
  }

  getAnswerText(idx) {
    const selected = this.answers.get(idx);
    const custom = this.customInputs.get(idx);
    const parts = [];
    if (selected.size > 0) parts.push([...selected].join(", "));
    if (custom.trim()) parts.push(custom.trim());
    return parts.join(", ");
  }

  selectOption(qIdx, label) {
    const q = this.questions[qIdx];
    const selected = this.answers.get(qIdx);
    const isMulti = q.multiSelect;

    if (isMulti) {
      if (selected.has(label)) selected.delete(label);
      else selected.add(label);
    } else {
      selected.clear();
      selected.add(label);
      this.customInputs.set(qIdx, "");
    }

    this.updateOptionVisuals(qIdx);
    if (this.config.immediateSelect && !isMulti) {
      const result = {};
      result[q.question] = label;
      this.handleResolve(result);
      return;
    }

    this.updateTabIndicators();
    if (!isMulti) this.switchTab(this.activeTabIndex + 1);
  }

  renderMultiSelectCheckbox(parent, checked) {
    parent.createSpan({
      text: checked ? "[✓] " : "[ ] ",
      cls: `claudian-ask-check${checked ? " is-checked" : ""}`,
    });
  }

  updateOptionVisuals(qIdx) {
    const q = this.questions[qIdx];
    const selected = this.answers.get(qIdx);
    const isMulti = q.multiSelect;

    for (let i = 0; i < q.options.length; i += 1) {
      const item = this.currentItems[i];
      if (!item) continue;
      const isSelected = selected.has(q.options[i].label);
      item.toggleClass("is-selected", isSelected);
      item.setAttribute("aria-checked", isSelected ? "true" : "false");

      if (isMulti) {
        const checkSpan = item.querySelector(".claudian-ask-check");
        if (checkSpan) {
          checkSpan.textContent = isSelected ? "[✓] " : "[ ] ";
          checkSpan.toggleClass("is-checked", isSelected);
        }
      } else {
        const labelRow = item.querySelector(".claudian-ask-label-row");
        const existingMark = item.querySelector(".claudian-ask-check-mark");
        if (isSelected && !existingMark && labelRow) {
          labelRow.createSpan({ text: " ✓", cls: "claudian-ask-check-mark" });
        } else if (!isSelected && existingMark) {
          existingMark.remove();
        }
      }
    }
  }

  updateFocusIndicator() {
    for (let i = 0; i < this.currentItems.length; i += 1) {
      const item = this.currentItems[i];
      const cursor = item.querySelector(".claudian-ask-cursor");
      if (i === this.focusedItemIndex) {
        item.addClass("is-focused");
        if (cursor) cursor.textContent = "›";
        item.scrollIntoView({ block: "nearest" });
        if (item.classList && item.classList.contains("claudian-ask-custom-item")) {
          const input = item.querySelector(".claudian-ask-custom-text");
          if (input) {
            input.focus();
            this.isInputFocused = true;
          }
        }
      } else {
        item.removeClass("is-focused");
        if (cursor) cursor.textContent = " ";
        if (item.classList && item.classList.contains("claudian-ask-custom-item")) {
          const input = item.querySelector(".claudian-ask-custom-text");
          if (input && document.activeElement === input) {
            input.blur();
            this.isInputFocused = false;
          }
        }
      }
    }
  }

  updateTabIndicators() {
    for (let idx = 0; idx < this.questions.length; idx += 1) {
      const tab = this.tabElements[idx];
      if (!tab) continue;
      const tick = tab.querySelector(".claudian-ask-tab-tick");
      const answered = this.isQuestionAnswered(idx);
      tab.toggleClass("is-answered", answered);
      if (tick) tick.textContent = answered ? " ✓" : "";
    }

    const submitTab = this.tabElements[this.questions.length];
    if (submitTab) {
      const submitCheck = submitTab.querySelector(".claudian-ask-tab-submit-check");
      const allAnswered = this.questions.every((_, i) => this.isQuestionAnswered(i));
      if (submitCheck) submitCheck.textContent = allAnswered ? "✓ " : "";
    }
  }

  handleNavigationKey(e, maxFocusIndex) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        this.focusedItemIndex = Math.min(this.focusedItemIndex + 1, maxFocusIndex);
        this.updateFocusIndicator();
        this.focusCurrentItem();
        return true;
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        this.focusedItemIndex = Math.max(this.focusedItemIndex - 1, 0);
        this.updateFocusIndicator();
        this.focusCurrentItem();
        return true;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        this.handleResolve(null);
        return true;
      default:
        return false;
    }
  }

  focusCurrentItem() {
    const item = this.currentItems[this.focusedItemIndex];
    if (!item) return;
    const customInput = typeof item.querySelector === "function"
      ? item.querySelector(".claudian-ask-custom-text")
      : null;
    const focusTarget = customInput || item;
    if (focusTarget && typeof focusTarget.focus === "function") focusTarget.focus();
  }

  handleKeyDown(e) {
    if (this.isInputFocused) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.isInputFocused = false;
        if (document.activeElement) document.activeElement.blur();
        const focusTarget = this.config.immediateSelect
          ? this.rootEl
          : this.tabElements[this.activeTabIndex];
        if (focusTarget && typeof focusTarget.focus === "function") focusTarget.focus();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        this.isInputFocused = false;
        if (document.activeElement) document.activeElement.blur();
        this.switchTab(this.activeTabIndex + 1);
        return;
      }
      return;
    }

    const eventTarget = e && e.target;
    if (eventTarget && eventTarget !== this.rootEl) {
      if (typeof eventTarget.getAttribute === "function" && eventTarget.getAttribute("role") === "tab") return;
      const itemIndex = this.currentItems.findIndex((item) => (
        item === eventTarget
        || (item && typeof item.contains === "function" && item.contains(eventTarget))
      ));
      if (itemIndex >= 0) {
        this.focusedItemIndex = itemIndex;
        if (["ArrowDown", "ArrowUp", "Escape"].includes(e.key)) {
          this.handleNavigationKey(e, this.currentItems.length - 1);
        }
        return;
      }
      return;
    }

    if (this.config.immediateSelect) {
      const q = this.questions[this.activeTabIndex];
      const maxIdx = q.options.length - 1;
      if (this.handleNavigationKey(e, maxIdx)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (this.focusedItemIndex <= maxIdx) {
          this.selectOption(this.activeTabIndex, q.options[this.focusedItemIndex].label);
        }
      }
      return;
    }

    const isSubmitTab = this.activeTabIndex === this.questions.length;
    const q = this.questions[this.activeTabIndex];
    const maxFocusIndex = isSubmitTab ? 1 : (this.config.showCustomInput ? q.options.length : q.options.length - 1);
    if (this.handleNavigationKey(e, maxFocusIndex)) return;

    if (isSubmitTab) {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (this.focusedItemIndex === 0) this.handleSubmit();
        else this.handleResolve(null);
      }
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (this.focusedItemIndex < q.options.length) {
        this.selectOption(this.activeTabIndex, q.options[this.focusedItemIndex].label);
      } else if (this.config.showCustomInput) {
        this.isInputFocused = true;
        const input = this.contentArea.querySelector(".claudian-ask-custom-text");
        if (input) input.focus();
      }
    }
  }

  handleSubmit() {
    const allAnswered = this.questions.every((_, i) => this.isQuestionAnswered(i));
    if (!allAnswered) return;

    const result = {};
    for (let i = 0; i < this.questions.length; i += 1) {
      result[this.questions[i].question] = this.getAnswerText(i);
    }
    this.handleResolve(result);
  }

  handleResolve(result) {
    if (this.resolved) return;
    this.resolved = true;
    if (this.rootEl) this.rootEl.removeEventListener("keydown", this.boundKeyDown);
    if (this.signal && this.abortHandler) {
      this.signal.removeEventListener("abort", this.abortHandler);
      this.abortHandler = null;
    }
    if (this.rootEl) this.rootEl.remove();
    this.resolveCallback(result);
  }
}


module.exports = { InlineAskUserQuestionPanel };

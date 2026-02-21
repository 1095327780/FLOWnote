function parseMaybeJsonObject(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || (!text.startsWith("{") && !text.startsWith("["))) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function splitQuestionOptionString(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  const byLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (byLines.length > 1) return byLines;
  if (text.includes(" / ")) {
    return text
      .split(" / ")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (text.includes("、")) {
    return text
      .split("、")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [text];
}

function normalizeQuestionOption(raw) {
  if (raw && typeof raw === "object") {
    const obj = raw;
    const label =
      (typeof obj.label === "string" && obj.label.trim()) ||
      (typeof obj.value === "string" && obj.value.trim()) ||
      (typeof obj.text === "string" && obj.text.trim()) ||
      (typeof obj.name === "string" && obj.name.trim()) ||
      "";
    const description =
      (typeof obj.description === "string" && obj.description.trim()) ||
      (typeof obj.desc === "string" && obj.desc.trim()) ||
      (typeof obj.hint === "string" && obj.hint.trim()) ||
      "";
    if (!label) return null;
    return { label, description };
  }
  const label = String(raw || "").trim();
  if (!label) return null;
  return { label, description: "" };
}

function parseQuestionOptions(rawOptions) {
  const collected = [];
  const pushOption = (value) => {
    const normalized = this.normalizeQuestionOption(value);
    if (normalized) collected.push(normalized);
  };

  if (Array.isArray(rawOptions)) {
    rawOptions.forEach((value) => pushOption(value));
  } else if (rawOptions && typeof rawOptions === "object") {
    const obj = rawOptions;
    if (Array.isArray(obj.options)) {
      obj.options.forEach((value) => pushOption(value));
    } else if (Array.isArray(obj.choices)) {
      obj.choices.forEach((value) => pushOption(value));
    } else if (Array.isArray(obj.items)) {
      obj.items.forEach((value) => pushOption(value));
    } else {
      Object.entries(obj).forEach(([key, value]) => {
        if (typeof value === "string" && value.trim()) {
          pushOption({ label: key, description: value.trim() });
          return;
        }
        if (value === true || value === false || typeof value === "number") {
          pushOption({ label: key, description: String(value) });
          return;
        }
        pushOption(value);
      });
    }
  } else if (typeof rawOptions === "string") {
    this.splitQuestionOptionString(rawOptions).forEach((value) => pushOption(value));
  }

  const deduped = [];
  const seen = new Set();
  for (const option of collected) {
    const label = String(option.label || "").trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    deduped.push({
      label,
      description: String(option.description || "").trim(),
    });
  }
  return deduped;
}

function normalizeQuestionItem(rawItem, index) {
  const obj = rawItem && typeof rawItem === "object"
    ? rawItem
    : { question: String(rawItem || "") };

  const question =
    (typeof obj.question === "string" && obj.question.trim()) ||
    (typeof obj.prompt === "string" && obj.prompt.trim()) ||
    (typeof obj.ask === "string" && obj.ask.trim()) ||
    (typeof obj.query === "string" && obj.query.trim()) ||
    (typeof obj.content === "string" && obj.content.trim()) ||
    (typeof obj.text === "string" && obj.text.trim()) ||
    (typeof obj.title === "string" && obj.title.trim()) ||
    (typeof obj.name === "string" && obj.name.trim()) ||
    "";
  if (!question) return null;

  const options = this.parseQuestionOptions(
    obj.options !== undefined
      ? obj.options
      : obj.choices !== undefined
        ? obj.choices
        : obj.items !== undefined
          ? obj.items
          : obj.answers !== undefined
            ? obj.answers
            : obj.selections !== undefined
              ? obj.selections
              : obj.values !== undefined
                ? obj.values
                : obj.select_options !== undefined
                  ? obj.select_options
                  : obj.selectOptions !== undefined
                    ? obj.selectOptions
                    : obj.candidates,
  );

  return {
    question,
    header: (typeof obj.header === "string" && obj.header.trim()) || `Q${index + 1}`,
    options,
    multiSelect: Boolean(obj.multiSelect || obj.multiple || obj.allowMultiple),
  };
}

function normalizeQuestionInput(rawInput) {
  const parsedFromString = this.parseMaybeJsonObject(rawInput);
  const input = parsedFromString || rawInput;

  let rawQuestions = [];
  if (Array.isArray(input)) {
    rawQuestions = input;
  } else if (input && typeof input === "object") {
    if (Array.isArray(input.questions)) {
      rawQuestions = input.questions;
    } else if (typeof input.questions === "string") {
      const parsedQuestions = this.parseMaybeJsonObject(input.questions);
      if (Array.isArray(parsedQuestions)) rawQuestions = parsedQuestions;
    } else if (input.questions && typeof input.questions === "object") {
      rawQuestions = Object.values(input.questions);
    } else if (typeof input.question === "string" || typeof input.prompt === "string" || typeof input.text === "string") {
      rawQuestions = [input];
    }
  }

  const normalized = [];
  const seenQuestion = new Set();
  for (let i = 0; i < rawQuestions.length; i += 1) {
    const item = this.normalizeQuestionItem(rawQuestions[i], i);
    if (!item) continue;
    const qKey = String(item.question || "").trim();
    if (!qKey || seenQuestion.has(qKey)) continue;
    seenQuestion.add(qKey);
    normalized.push(item);
  }
  return normalized;
}

function parseQuestionsFromDetailText(detailText) {
  const text = String(detailText || "").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const questions = [];
  let current = null;

  const pushCurrent = () => {
    if (!current || !String(current.question || "").trim()) return;
    current.options = this.parseQuestionOptions(current.options);
    questions.push(current);
    current = null;
  };

  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) continue;
    if (line.startsWith("问题:")) {
      pushCurrent();
      current = {
        question: line.replace(/^问题:\s*/, "").trim(),
        header: `Q${questions.length + 1}`,
        options: [],
        multiSelect: false,
      };
      continue;
    }
    if (line.startsWith("选项:")) {
      if (!current) continue;
      const optionText = line.replace(/^选项:\s*/, "").trim();
      current.options = this.splitQuestionOptionString(optionText);
    }
  }
  pushCurrent();

  return questions.filter((item) => item && String(item.question || "").trim());
}

function extractQuestionItemsFromBlock(block) {
  if (!block || typeof block !== "object") return [];
  const sources = [];
  if (block.toolInput !== undefined) sources.push(block.toolInput);
  if (block.raw && block.raw.state && block.raw.state.input !== undefined) sources.push(block.raw.state.input);
  if (block.raw && block.raw.input !== undefined) sources.push(block.raw.input);

  for (const source of sources) {
    const normalized = this.normalizeQuestionInput(source);
    if (normalized.length) return normalized;
  }
  if (typeof block.detail === "string" && block.detail.trim()) {
    const fromDetail = this.parseQuestionsFromDetailText(block.detail);
    if (fromDetail.length) return fromDetail;
  }
  return [];
}

function buildFallbackQuestionItemsFromRequest(request) {
  const req = request && typeof request === "object" ? request : {};
  let question = "";
  if (typeof req.question === "string" && req.question.trim()) {
    question = req.question.trim();
  } else if (typeof req.prompt === "string" && req.prompt.trim()) {
    question = req.prompt.trim();
  } else if (typeof req.title === "string" && req.title.trim()) {
    question = req.title.trim();
  }
  if (!question) {
    question = "OpenCode 需要你的输入，请填写后提交继续。";
  }
  return [
    {
      header: "Q1",
      question,
      options: [],
      multiSelect: false,
    },
  ];
}


const parseMethods = {
  parseMaybeJsonObject,
  splitQuestionOptionString,
  normalizeQuestionOption,
  parseQuestionOptions,
  normalizeQuestionItem,
  normalizeQuestionInput,
  parseQuestionsFromDetailText,
  extractQuestionItemsFromBlock,
  buildFallbackQuestionItemsFromRequest,
};

module.exports = { parseMethods };

const { normalizeSupportedLocale } = require("./i18n-locale-utils");

const SKILL_DESCRIPTIONS = {
  en: {
    ah: "FLOWnote knowledge-base router. Use when the user is unsure which skill to choose, wants a feature menu, or wants automatic routing by intent.",
    "ah-archive": "Project archiving guide. Checks completion, summarizes retrospectives, marks reusable material, moves project folders, updates area links, and reports the archive result.",
    "ah-capture": "Quick daytime capture. Appends records, new tasks, or completed tasks to today's daily note with minimal interaction.",
    "ah-card": "Luhmann-style card creation guide. Routes saved articles, literature notes, and user notes into the right card-making workflow.",
    "ah-inbox": "Batch inbox clearing assistant. Processes leftover or postponed daily records from ah-review and writes back clear handling decisions.",
    "ah-init": "Knowledge-base initialization and index management. Builds or migrates the vault, validates folders, initializes pages, and reports index status.",
    "ah-legacy": "Legacy note processing guide. Triage migrated notes and route knowledge notes or project notes into the right conversion workflow.",
    "ah-memory": "Cross-skill progress memory. Tracks tasks and state across ah-* skills so context survives session changes.",
    "ah-month": "Monthly review workflow. Clears monthly leftovers, handles later-buffer items, and produces next-month direction and the monthly note.",
    "ah-note": "Morning daily-note workflow. Creates today's note, rolls over unfinished work, gathers planning sources, and sets today's focus.",
    "ah-project": "New project startup workflow. Checks numbering, creates the project folder and home page, and updates related area pages.",
    "ah-read": "Reading and literature-note workflow. Captures reading progress, extracts insights, and prepares material for later card creation.",
    "ah-review": "Evening daily review. Reviews focus and tasks, processes today's records, and hands leftovers to ah-inbox when needed.",
    "ah-think": "Deep thinking assistant for reading, study, card notes, and decisions: clarify concepts, test arguments, compare options, and extract transferable insights.",
    "ah-week": "Weekly review workflow. Clears weekly leftovers and aligns next week's plan with this month's direction.",
    "ah-year": "Yearly review workflow. Integrates monthly notes and plan execution, then confirms next year's direction and plan.",
  },
  ru: {
    ah: "Центр маршрутизации базы знаний FLOWnote. Используется, когда пользователь не уверен, какой skill выбрать, хочет меню функций или автоматическую маршрутизацию по намерению.",
    "ah-archive": "Гид по архивированию проектов: проверяет завершенность, делает ретроспективу, помечает материал для извлечения, переносит папки проекта, обновляет ссылки областей и сообщает результат.",
    "ah-capture": "Быстрый дневной захват: добавляет записи, новые задачи или выполненные задачи в сегодняшнюю ежедневную заметку с минимальным числом действий.",
    "ah-card": "Гид по созданию карточек в стиле Лумана. Направляет сохраненные статьи, литературные заметки и пользовательские заметки в подходящий сценарий карточек.",
    "ah-inbox": "Помощник пакетной очистки inbox: обрабатывает оставшиеся или отложенные ежедневные записи из ah-review и записывает понятные решения.",
    "ah-init": "Инициализация базы знаний и управление индексом: создает или переносит хранилище, проверяет папки, инициализирует страницы и сообщает статус индекса.",
    "ah-legacy": "Гид по обработке старых заметок: сортирует перенесенные заметки и направляет знания или проекты в нужный процесс преобразования.",
    "ah-memory": "Память прогресса между skills: отслеживает задачи и состояние между ah-* skills, чтобы контекст сохранялся после смены сессии.",
    "ah-month": "Месячный обзор: закрывает остатки месяца, обрабатывает буфер «позже» и формирует направление на следующий месяц и месячную заметку.",
    "ah-note": "Утренний сценарий ежедневной заметки: создает заметку на сегодня, переносит незавершенное, собирает источники плана и задает фокус дня.",
    "ah-project": "Запуск нового проекта: проверяет нумерацию, создает папку и главную страницу проекта, обновляет связанные страницы областей.",
    "ah-read": "Сценарий чтения и литературных заметок: фиксирует прогресс чтения, извлекает инсайты и готовит материал для будущих карточек.",
    "ah-review": "Вечерний ежедневный обзор: проверяет фокус и задачи, обрабатывает записи дня и передает остатки в ah-inbox при необходимости.",
    "ah-think": "Помощник глубокого мышления для чтения, учебы, карточек и решений: проясняет понятия, проверяет аргументы, сравнивает варианты и выделяет переносимые выводы.",
    "ah-week": "Недельный обзор: закрывает остатки недели и согласует план на следующую неделю с направлением текущего месяца.",
    "ah-year": "Годовой обзор: объединяет месячные заметки и выполнение плана, затем подтверждает направление и план на следующий год.",
  },
};

function getLocalizedSkillDescription(skill, locale = "zh-CN") {
  const normalized = normalizeSupportedLocale(locale, "zh-CN");
  const slug = String((skill && (skill.slug || skill.name)) || "").trim();
  if (normalized === "zh-CN") return String((skill && skill.description) || "");
  const table = SKILL_DESCRIPTIONS[normalized] || SKILL_DESCRIPTIONS.en;
  return table[slug] || SKILL_DESCRIPTIONS.en[slug] || String((skill && skill.description) || "");
}

module.exports = {
  SKILL_DESCRIPTIONS,
  getLocalizedSkillDescription,
};

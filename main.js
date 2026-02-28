const obsidianModule = require("obsidian");
const { setRuntimeLocale } = (() => {
  try {
    return require("./runtime/runtime-locale-state");
  } catch (_e) {
    return { setRuntimeLocale: () => "en" };
  }
})();
const {
  Modal = class {},
  Notice = class {},
  Plugin = class {},
  Platform = { isMobile: false },
  PluginSettingTab = class {},
  Setting = class {},
  normalizePath = (value) => String(value || ""),
  requestUrl = async () => ({ status: 500, text: "", json: null }),
} = obsidianModule;

const DEFAULT_VIEW_TYPE = "flownote-view";
const SUPPORTED_UI_LOCALES = ["zh-CN", "en"];
const DEFAULT_UI_LOCALE = "en";
const UI_LANGUAGE_OPTIONS = ["auto", ...SUPPORTED_UI_LOCALES];

function normalizeUiLanguage(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "auto") return "auto";
  if (raw === "zh-cn" || raw === "zh_cn" || raw === "zh") return "zh-CN";
  if (raw.startsWith("en")) return "en";
  return "auto";
}

function normalizeSupportedLocale(value, fallback = DEFAULT_UI_LOCALE) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "zh-cn" || raw === "zh_cn" || raw === "zh" || raw.startsWith("zh-")) return "zh-CN";
  if (raw.startsWith("en")) return "en";
  if (fallback === null || fallback === undefined) return DEFAULT_UI_LOCALE;
  return String(fallback);
}

function resolveLocaleFromNavigator(navigatorLike, fallback = DEFAULT_UI_LOCALE) {
  const nav = navigatorLike && typeof navigatorLike === "object" ? navigatorLike : null;
  const candidates = [];
  if (nav && Array.isArray(nav.languages)) {
    for (const item of nav.languages) {
      if (typeof item === "string" && item.trim()) candidates.push(item.trim());
    }
  }
  if (nav && typeof nav.language === "string" && nav.language.trim()) {
    candidates.push(nav.language.trim());
  }
  if (!candidates.length) return normalizeSupportedLocale(fallback, fallback);
  for (const locale of candidates) {
    const normalized = normalizeSupportedLocale(locale, "");
    if (SUPPORTED_UI_LOCALES.includes(normalized)) return normalized;
  }
  return normalizeSupportedLocale(fallback, fallback);
}

function getMessageByPath(messages, path) {
  if (!messages || typeof messages !== "object") return undefined;
  const keys = String(path || "").split(".");
  let cursor = messages;
  for (const key of keys) {
    if (!cursor || typeof cursor !== "object" || !(key in cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function interpolateI18n(template, params = {}) {
  const text = String(template || "");
  return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return "";
    const value = params[name];
    return value === undefined || value === null ? "" : String(value);
  });
}

const I18N_MESSAGES = {
  "zh-CN": {
    commands: {
      open: "打开",
      sendSelectedText: "发送选中文本",
      newSession: "新建会话",
      mobileQuickCapture: "快速捕获想法",
    },
    notices: {
      pickTextFirst: "请先选择文本",
      pluginLoadFailed: "FLOWnote 加载失败: {message}",
      mobileLoadFailed: "FLOWnote 移动端加载失败: {message}",
      captureSaved: "✅ 想法已捕获",
      captureFailed: "捕获失败: {message}",
      needApiKeyFirst: "请先填写 API Key",
      languageAppliedReloadTip: "界面语言已更新。命令名和 Ribbon 提示将在重载插件后生效。",
    },
    errors: {
      localFsOnly: "仅支持本地文件系统 Vault",
      aiMissingConfig: "AI 服务未配置：缺少 Base URL 或 API Key",
      aiResponseEmpty: "AI 返回内容为空",
      resolverUnsupported: "不支持的解析服务: {providerId}",
      resolverInvalidJson: "响应不是有效 JSON",
      resolverBodyEmpty: "正文为空",
      resolverFailed: "解析失败",
      resolverFailedGeneral: "链接解析失败",
      resolverRateLimited: "频率受限",
      resolverTimeout: "服务超时",
      resolverUnavailable: "服务不可用",
    },
    settings: {
      language: {
        name: "界面语言",
        desc: "默认跟随设备语言。切换后界面即时刷新；命令名与 Ribbon 提示重载后生效。",
        optionAuto: "跟随系统（推荐）",
        optionZhCN: "简体中文",
        optionEn: "English",
        reinstallPromptTitle: "重装对应语言 Skills？",
        reinstallPromptDesc: "当前语言已切换为 {language}。是否现在重装对应语言版本的内置 Skills 与模板？",
        reinstallPromptConfirm: "立即重装",
        reinstallPromptCancel: "稍后",
      },
      mobile: {
        intro: "配置 AI 服务和日记路径，用于移动端快速捕获想法。",
      },
      basic: {
        intro: "常用情况下只需要确认连接状态和 Provider 登录。其余高级项一般保持默认即可。",
        cliPathName: "FLOWnote CLI 路径（可选）",
        cliPathDesc: "通常留空。插件会自动探测。Windows 本机请优先填写 opencode.exe 或 cli.js（不要填 opencode.cmd）；Windows + WSL 可填 wsl、wsl.exe 或 wsl:发行版名（例如 wsl:Ubuntu）。",
        launchStrategyName: "连接启动方式",
        launchStrategyDescWindows: "自动（推荐）：按系统自动检测并记忆成功方式。手动模式下按你选择的安装方式连接。",
        launchStrategyDesc: "自动（推荐）：优先使用上次成功方式；失败时自动回退到其他方式。",
        launchAuto: "自动（推荐）",
        launchNativeWindows: "Windows 本机安装",
        launchWsl: "Windows WSL 安装",
        launchNativeMac: "Mac 本机安装",
        wslDistroName: "WSL 发行版（可选）",
        wslDistroDesc: "留空表示 WSL 默认发行版。可填 Ubuntu / Debian 等。填写后自动模式会优先尝试 WSL。",
        skillInjectModeName: "技能注入方式",
        skillInjectModeDesc: "当你使用 /skill 指令时，插件如何把技能内容传给模型。",
        skillInjectModeSummary: "摘要注入（推荐）",
        skillInjectModeFull: "全文注入（更完整但更重）",
        skillInjectModeOff: "关闭注入（只发送用户输入）",
        advancedHeading: "高级设置",
        experimentalSdkName: "实验功能：启用 SDK 传输",
        experimentalSdkDesc: "默认关闭。生产建议使用 compat 传输；仅在调试场景中开启 SDK。",
        transportModeName: "实验传输模式",
        transportModeDesc: "兼容模式为稳定路径；SDK 模式仅用于实验排障。",
        transportModeCompat: "compat（稳定）",
        transportModeSdk: "sdk（实验）",
        skillsDirName: "内置 Skills 安装目录",
        skillsDirDesc: "默认 .opencode/skills。插件会自动安装内置 skills，并忽略目录中的非内置 skills。通常无需修改。",
        reinstallSkillsName: "重新安装内置 Skills 与模板",
        reinstallSkillsDesc: "按当前界面语言安装/更新内置 skills，并将 Meta/模板 同步到各 skill 资源目录。遇到同名冲突会询问替换或忽略。",
        reinstallSkillsNow: "立即重装",
        reinstallSkillsBusy: "重装中...",
        reinstallSkillsSuccess: "重装完成：skills {synced}/{total}，templates {syncedTemplates}/{totalTemplates}，目录 {targetRoot}",
        reinstallSkillsSuccessWithMeta: "重装完成：skills {synced}/{total}，templates {syncedTemplates}/{totalTemplates}，meta {syncedMetaTemplates}/{totalMetaTemplates}，目录 {targetRoot}",
        reinstallSkillsCanceled: "已取消重装。已处理 skills {synced}/{total}，templates {syncedTemplates}/{totalTemplates}。",
        reinstallSkillsFailed: "重装失败：{message}",
        resetTemplateBaselineName: "重置模板基线",
        resetTemplateBaselineDesc: "仅当你需要恢复默认模板时使用。会把内置模板写回 Meta/模板（冲突可逐项替换或忽略）。",
        resetTemplateBaselineNow: "重置模板",
        resetTemplateBaselineBusy: "重置中...",
        resetTemplateBaselineSuccess: "模板重置完成：{synced}/{total}，目录 {metaRoot}",
        resetTemplateBaselineCanceled: "已取消模板重置。已处理 {synced}/{total}。",
        resetTemplateBaselineFailed: "模板重置失败：{message}",
        contentConflictTitle: "发现同名冲突",
        contentConflictDesc: "{kind} `{id}` 已存在。请选择处理方式。",
        contentConflictTarget: "目标：{path}",
        contentConflictSource: "来源：{path}",
        conflictKindSkill: "技能",
        conflictKindTemplate: "模板",
        conflictKindMetaTemplate: "Meta 模板",
        conflictReplace: "替换",
        conflictSkip: "忽略",
        conflictReplaceAll: "全部替换",
        conflictSkipAll: "全部忽略",
        conflictCancel: "取消",
        unknownError: "未知错误",
        diagnosticsName: "连接诊断",
        diagnosticsDesc: "检测 FLOWnote 可执行文件与连接状态。",
        diagnosticsRun: "运行诊断",
        diagnosticsBusy: "测试中...",
        diagnosticsOk: "连接正常 ({mode})",
        diagnosticsFailed: "连接失败: {error}",
        autoMemoryRememberedWsl: "已记忆：WSL{distro}",
        autoMemoryRememberedNative: "已记忆：本机 {command}",
        autoMemoryNone: "当前未记忆成功连接方式。",
        autoMemoryName: "自动连接记忆",
        autoMemoryDesc: "{rememberedText} 成功连接后会自动更新。",
        autoMemoryReset: "重置记忆",
        autoMemoryResetDone: "已清除记忆的连接方式。",
        autoMemoryResetFailed: "重置失败: {message}",
      },
      mobileCapture: {
        heading: "移动端快速捕获",
        intro: "在桌面端预先配置移动端捕获设置。同步到移动端后即可使用。",
        resolverHint: {
          tianapi: "适合基础网页正文抓取；动态页面或强反爬页面可能失败。",
          showapi: "按调用计费，部分套餐有免费额度；适合作为低门槛选项。",
          gugudata: "输出 Markdown 质量较稳定；官方建议控制请求频率。",
        },
        resolverProvider: {
          tianapi: { name: "TianAPI", keyLabel: "TianAPI Key" },
          showapi: { name: "ShowAPI（万维易源）", keyLabel: "ShowAPI AppKey" },
          gugudata: { name: "咕咕数据", keyLabel: "咕咕数据 AppKey" },
        },
      },
      providerAuth: {
        heading: "Provider 登录管理（OAuth / API Key）",
        intro: "用于在插件内连接官方/第三方模型 provider。完成后会写入当前插件运行时的 FLOWnote 凭据。",
        refresh: "刷新 Provider 状态",
        expandAll: "全部展开",
        collapseAll: "全部收起",
        searchPlaceholder: "搜索 Provider / ID / 鉴权方式 / 模型数",
        loading: "加载中...",
        notLoaded: "尚未加载 Provider 信息。",
        loadedNoResult: "已加载 {totalProviders} 个 Provider，搜索“{query}”无结果。",
        loaded: "已加载 {totalProviders} 个 Provider。",
        loadedWithCount: "已加载 {totalProviders} 个 Provider，当前显示 {visibleCount} 个；已连接 {connectedCount} 个。",
        noMatch: "没有匹配的 Provider，请尝试更换关键词。",
        empty: "当前没有可显示的 Provider。",
        groupDomestic: "国产厂商",
        groupGlobal: "海外厂商",
        groupUnknownCountry: "其他/未知国家",
        refreshBusy: "刷新中...",
        loadingProviders: "正在读取 Provider 配置...",
        readFailed: "读取失败：{message}",
        readFailedDetail: "读取 Provider 信息失败：{message}",
        connected: "已连接",
        disconnected: "未连接",
        providerMeta: "模型数：{modelCount}；鉴权方式：{methodText}",
        actionFailed: "操作失败：{message}",
        oauthLogin: "OAuth 登录",
        pending: "处理中...",
        setApiKey: "设置 API Key",
        saving: "保存中...",
        clearLogin: "清除登录",
        clearing: "清除中...",
        clearTitle: "清除 {providerName} 登录",
        clearDesc: "确认清除该 Provider 的登录凭据？",
        clearSubmit: "清除",
        clearDone: "已清除登录凭据。",
        clearNotice: "{providerName} 凭据已清除",
        pickOauthTitle: "选择 {providerName} 的 OAuth 登录方式",
        pickOauthDesc: "请选择一种 OAuth 鉴权方式。",
        continue: "继续",
        invalidOauthMethod: "无效的 OAuth 方式序号",
        oauthCanceled: "已取消 OAuth 登录。",
        oauthCreatingLink: "正在创建授权链接...",
        oauthMissingUrl: "未获取到 OAuth 授权链接",
        oauthOpened: "已打开 {providerName} 授权页面",
        oauthCopied: "无法自动打开浏览器，授权链接已复制到剪贴板。",
        oauthCallbackTitle: "{providerName} OAuth 回调",
        oauthCallbackDesc: "请在浏览器完成授权后粘贴 code。",
        oauthCallbackPlaceholder: "粘贴授权 code",
        submit: "提交",
        oauthCodeMissing: "未填写授权 code，已取消。",
        oauthCompleteInBrowser: "请在浏览器完成授权。",
        oauthThenConfirm: "完成后点击“确认”继续。",
        confirm: "确认",
        oauthSubmitting: "正在提交 OAuth 回调...",
        oauthDone: "OAuth 登录完成。",
        oauthSuccess: "{providerName} 登录成功",
        apiKeyTitle: "设置 {providerName} API Key",
        apiKeyDesc: "请输入该 Provider 的 API Key（仅保存在本地 FLOWnote 凭据中）。",
        apiKeyPlaceholder: "输入 API Key",
        save: "保存",
        apiKeyCanceled: "已取消 API Key 设置。",
        apiKeyEmpty: "API Key 不能为空。",
        apiKeySaving: "正在保存 API Key...",
        apiKeySaved: "API Key 已保存。",
        apiKeySavedNotice: "{providerName} API Key 已保存",
        noAuthMethods: "无可用鉴权方式",
      },
    },
    mobile: {
      providers: {
        deepseek: "DeepSeek",
        qwen: "通义千问",
        moonshot: "Moonshot (Kimi)",
        zhipu: "智谱 (GLM)",
        siliconflow: "SiliconFlow",
        custom: "自定义",
      },
      capture: {
        title: "💡 快速捕获",
        inputPlaceholder: "此刻在想什么…",
        hintSend: "⌘/Ctrl + Enter 发送",
        cancel: "取消",
        submit: "记录",
        submitBusy: "记录中…",
        statusAiCleanup: "🤖 AI 清理中…",
        statusAiCleanupFailed: "⚠️ AI 清理失败，使用原文",
        statusResolver: "🔗 解析链接内容…",
        statusResolverFailed: "⚠️ 链接解析失败，已回退原文：{message}",
        statusWriteNote: "📝 写入日记…",
        emptyInput: "请输入内容",
      },
      settings: {
        providerName: "AI 提供商",
        providerDesc: "选择一个预设提供商，或选择自定义填写地址。",
        apiKeyName: "API Key",
        apiKeyDesc: "用于 AI 清理与链接解析失败时的 AI 回退。留空则不走 AI。",
        providerKeyLinkPrefix: "前往 {name} 获取 →",
        baseUrlName: "Base URL（可选）",
        baseUrlDesc: "留空使用预设地址。当前生效: {value}",
        modelName: "模型名（可选）",
        modelDesc: "留空使用预设模型。当前生效: {value}",
        aiCleanupName: "启用 AI 清理",
        aiCleanupDesc: "开启后自动去除语气词（嗯、啊、那个等）。关闭则直接记录原文。",
        urlSummaryName: "启用链接解析",
        urlSummaryDesc: "优先走国内解析服务（天聚/万维易源/咕咕数据），失败后自动回退 AI，再回退纯文本。",
        resolverSwitchName: "解析服务总开关",
        resolverSwitchDesc: "关闭后不请求任何链接解析服务。",
        resolverProviderName: "链接解析服务商",
        resolverProviderDesc: "三选一配置即可，插件只会使用当前选中的服务商。",
        resolverEntryPrefix: "配置入口：",
        resolverBuyKey: "申请/购买 Key",
        resolverDocs: "接口文档",
        resolverEntrySuffix: "。若目标网页反爬或动态加载失败，将自动降级到 AI，再降级到原文保留。",
        timeoutName: "解析超时(ms)",
        timeoutDesc: "单次解析请求超时，默认 25000。",
        retriesName: "失败重试次数",
        retriesDesc: "单服务重试次数，默认 2。",
        concurrencyName: "最大并发",
        concurrencyDesc: "并发解析 URL 上限，默认 2。",
        dailyPathName: "每日笔记路径",
        dailyPathDesc: "日记文件夹的相对路径（不含文件名）。",
        headerName: "想法区域标题",
        headerDesc: "日记中用于存放想法的区域标题。",
        testName: "测试连接",
        testDesc: "验证 AI 服务是否可用。",
        testBtn: "测试",
        testBusy: "测试中...",
      },
      url: {
        statusProviderMissing: "⚠️ {providerName} 未配置 Key，已回退 AI",
        statusNoResolverOrAi: "⚠️ 未配置解析或 AI，已回退纯文本",
        statusAiSummary: "🤖 生成链接摘要…",
        statusFallbackAi: "⚠️ {hint}，已回退 AI",
        statusFallbackPlain: "⚠️ {hint}，已回退纯文本",
        statusResolverNoAi: "⚠️ 已解析链接但未配置 AI，已回退纯文本",
        statusAiSummaryFailed: "⚠️ AI 摘要失败，已回退纯文本",
        statusPartialResolverFailed: "⚠️ 部分链接解析失败，已使用可用结果",
      },
      parser: {
        originalUrlPlaceholder: "原始URL",
        originalTextPrefix: "原文",
        summaryFallback: "暂无法解析，已保留原始链接",
        summaryPrefix: "链接摘要",
        linkLabel: "链接{index}",
        untitled: "（无标题）",
        empty: "（空）",
      },
      template: {
        daily: "# {{date}}\n\n## 📋 今日计划\n- [ ]\n\n## 📝 今日记录\n\n### 💡 想法和灵感\n\n### 📖 学习笔记\n\n## 🔄 每日回顾\n- 今天做了什么：\n- 明天计划：\n",
        recordHeading: "## 📝 今日记录",
      },
      prompts: {
        cleanup: "你是一个文字清理助手。你的唯一任务是去除口语中的语气词和填充词（如：嗯、啊、那个、就是、然后、对、哦、emmm、额 等），\n让句子更简洁。\n规则：\n1. 只去除语气词和填充词\n2. 不要改写、润色或美化原文\n3. 不要添加任何新内容\n4. 不要改变原文的意思和表达方式\n5. 保留所有实质内容和原始用词\n6. 保留所有 URL 链接，原样输出，绝对不要改动、解释或回复 URL 内容\n7. 直接返回清理后的文本，不要任何解释或前缀",
        urlSummary: "你是一个链接摘要助手。用户文本中包含 URL，我已经抓取了对应页面内容。\n请输出：保留原文不改动，并在末尾追加摘要列表。\n格式：每条一行 `> 📎 原始URL - 摘要`\n规则：\n- 必须保留原文中的所有原始 URL，不能替换、删改、缩短\n- 摘要不超过 50 字\n- 不要改动 URL 以外的原文内容\n- 如果内容不足，写“暂无法解析，已保留原始链接”\n- 直接返回处理后的完整文本，不要解释",
        urlFallback: "你是一个链接降级助手。\n任务：在无法获取网页正文时，对原文做最小化处理。\n规则：\n1. 原文必须完整保留，所有 URL 必须保留原样\n2. 不允许改写原文，不允许编造网页内容\n3. 仅可在末尾追加提示行，格式 `> 📎 原始URL - 暂无法解析，已保留原始链接`\n4. 直接返回处理后的完整文本",
      },
    },
  },
  en: {
    commands: {
      open: "Open",
      sendSelectedText: "Send Selected Text",
      newSession: "New Session",
      mobileQuickCapture: "Quick Idea Capture",
    },
    notices: {
      pickTextFirst: "Select text first.",
      pluginLoadFailed: "FLOWnote failed to load: {message}",
      mobileLoadFailed: "FLOWnote mobile failed to load: {message}",
      captureSaved: "✅ Idea captured",
      captureFailed: "Capture failed: {message}",
      needApiKeyFirst: "Please fill API Key first.",
      languageAppliedReloadTip: "UI language updated. Command names and Ribbon tooltip apply after plugin reload.",
    },
    errors: {
      localFsOnly: "Only local filesystem vaults are supported.",
      aiMissingConfig: "AI is not configured: missing Base URL or API Key.",
      aiResponseEmpty: "AI returned empty content.",
      resolverUnsupported: "Unsupported resolver provider: {providerId}",
      resolverInvalidJson: "Resolver response is not valid JSON.",
      resolverBodyEmpty: "Empty page content.",
      resolverFailed: "Resolver failed",
      resolverFailedGeneral: "URL resolver failed",
      resolverRateLimited: "Rate limited",
      resolverTimeout: "Resolver timed out",
      resolverUnavailable: "Resolver unavailable",
    },
    settings: {
      language: {
        name: "UI Language",
        desc: "Default follows device language. UI updates immediately; command names and Ribbon tooltip update after plugin reload.",
        optionAuto: "Follow System (Recommended)",
        optionZhCN: "简体中文",
        optionEn: "English",
        reinstallPromptTitle: "Reinstall language-specific Skills?",
        reinstallPromptDesc: "UI language is now {language}. Reinstall bundled Skills & Templates for this language now?",
        reinstallPromptConfirm: "Reinstall Now",
        reinstallPromptCancel: "Later",
      },
      mobile: {
        intro: "Configure AI and note paths for quick mobile idea capture.",
      },
      basic: {
        intro: "In most cases, you only need to verify connection status and Provider auth. Keep other advanced options at default.",
        cliPathName: "FLOWnote CLI Path (Optional)",
        cliPathDesc: "Usually leave empty. The plugin auto-detects it. On native Windows, prefer opencode.exe or cli.js (do not use opencode.cmd). On Windows + WSL, you can set wsl, wsl.exe, or wsl:distro (e.g. wsl:Ubuntu).",
        launchStrategyName: "Connection Launch Strategy",
        launchStrategyDescWindows: "Auto (Recommended): detect by system and remember successful method. In manual mode, connect with your selected install type.",
        launchStrategyDesc: "Auto (Recommended): try last successful method first and fallback automatically on failure.",
        launchAuto: "Auto (Recommended)",
        launchNativeWindows: "Native Windows Install",
        launchWsl: "Windows WSL Install",
        launchNativeMac: "Native Mac Install",
        wslDistroName: "WSL Distro (Optional)",
        wslDistroDesc: "Leave empty for default WSL distro. You can set Ubuntu / Debian etc. Filled value is preferred in auto mode.",
        skillInjectModeName: "Skill Injection Mode",
        skillInjectModeDesc: "How plugin injects skill content when you use /skill command.",
        skillInjectModeSummary: "Summary Injection (Recommended)",
        skillInjectModeFull: "Full Injection (More complete but heavier)",
        skillInjectModeOff: "Disable Injection (Send only user input)",
        advancedHeading: "Advanced Settings",
        experimentalSdkName: "Experimental: Enable SDK Transport",
        experimentalSdkDesc: "Disabled by default. Production should use compat transport; enable SDK only for debugging.",
        transportModeName: "Experimental Transport Mode",
        transportModeDesc: "Compat is stable path; SDK mode is for experimental troubleshooting.",
        transportModeCompat: "compat (Stable)",
        transportModeSdk: "sdk (Experimental)",
        skillsDirName: "Bundled Skills Install Directory",
        skillsDirDesc: "Default is .opencode/skills. Plugin installs bundled skills automatically and ignores non-bundled skills in this dir. Usually no change needed.",
        reinstallSkillsName: "Reinstall Bundled Skills & Templates",
        reinstallSkillsDesc: "Install/update bundled skills for the current UI language and sync Meta/Templates into each skill resource folder. If conflicts exist, you can replace or skip.",
        reinstallSkillsNow: "Reinstall Now",
        reinstallSkillsBusy: "Reinstalling...",
        reinstallSkillsSuccess: "Reinstall complete: skills {synced}/{total}, templates {syncedTemplates}/{totalTemplates}, dir {targetRoot}",
        reinstallSkillsSuccessWithMeta: "Reinstall complete: skills {synced}/{total}, templates {syncedTemplates}/{totalTemplates}, meta {syncedMetaTemplates}/{totalMetaTemplates}, dir {targetRoot}",
        reinstallSkillsCanceled: "Reinstall canceled. Processed skills {synced}/{total}, templates {syncedTemplates}/{totalTemplates}.",
        reinstallSkillsFailed: "Reinstall failed: {message}",
        resetTemplateBaselineName: "Reset Template Baseline",
        resetTemplateBaselineDesc: "Use only when you need defaults restored. It writes built-in templates back to Meta/Templates (conflicts are replace/skip).",
        resetTemplateBaselineNow: "Reset Templates",
        resetTemplateBaselineBusy: "Resetting...",
        resetTemplateBaselineSuccess: "Template reset complete: {synced}/{total}, dir {metaRoot}",
        resetTemplateBaselineCanceled: "Template reset canceled. Processed {synced}/{total}.",
        resetTemplateBaselineFailed: "Template reset failed: {message}",
        contentConflictTitle: "Name Conflict Detected",
        contentConflictDesc: "{kind} `{id}` already exists. Choose how to proceed.",
        contentConflictTarget: "Target: {path}",
        contentConflictSource: "Source: {path}",
        conflictKindSkill: "Skill",
        conflictKindTemplate: "Template",
        conflictKindMetaTemplate: "Meta Template",
        conflictReplace: "Replace",
        conflictSkip: "Skip",
        conflictReplaceAll: "Replace All",
        conflictSkipAll: "Skip All",
        conflictCancel: "Cancel",
        unknownError: "Unknown error",
        diagnosticsName: "Connection Diagnostics",
        diagnosticsDesc: "Check FLOWnote executable and connection status.",
        diagnosticsRun: "Run Diagnostics",
        diagnosticsBusy: "Testing...",
        diagnosticsOk: "Connection healthy ({mode})",
        diagnosticsFailed: "Connection failed: {error}",
        autoMemoryRememberedWsl: "Remembered: WSL{distro}",
        autoMemoryRememberedNative: "Remembered: Native {command}",
        autoMemoryNone: "No successful connection method remembered yet.",
        autoMemoryName: "Auto Connection Memory",
        autoMemoryDesc: "{rememberedText} It updates automatically after successful connections.",
        autoMemoryReset: "Reset Memory",
        autoMemoryResetDone: "Remembered connection method has been cleared.",
        autoMemoryResetFailed: "Reset failed: {message}",
      },
      mobileCapture: {
        heading: "Mobile Quick Capture",
        intro: "Pre-configure mobile capture settings on desktop. It can be used on mobile after sync.",
        resolverHint: {
          tianapi: "Suitable for basic webpage content extraction; dynamic or anti-crawl pages may fail.",
          showapi: "Usage-based billing with some free quota on selected plans; good low-barrier option.",
          gugudata: "Stable Markdown quality output; official docs recommend rate control.",
        },
        resolverProvider: {
          tianapi: { name: "TianAPI", keyLabel: "TianAPI Key" },
          showapi: { name: "ShowAPI", keyLabel: "ShowAPI AppKey" },
          gugudata: { name: "Gugudata", keyLabel: "Gugudata AppKey" },
        },
      },
      providerAuth: {
        heading: "Provider Auth Management (OAuth / API Key)",
        intro: "Connect official/third-party model providers inside the plugin. Credentials are written to FLOWnote runtime auth storage.",
        refresh: "Refresh Provider Status",
        expandAll: "Expand All",
        collapseAll: "Collapse All",
        searchPlaceholder: "Search Provider / ID / Auth Method / Model Count",
        loading: "Loading...",
        notLoaded: "Provider info has not been loaded yet.",
        loadedNoResult: "Loaded {totalProviders} providers, no result for \"{query}\".",
        loaded: "Loaded {totalProviders} providers.",
        loadedWithCount: "Loaded {totalProviders} providers, showing {visibleCount}; connected {connectedCount}.",
        noMatch: "No matching provider. Try another keyword.",
        empty: "No providers to display.",
        groupDomestic: "Domestic Providers",
        groupGlobal: "Global Providers",
        groupUnknownCountry: "Other / Unknown Country",
        refreshBusy: "Refreshing...",
        loadingProviders: "Reading Provider configuration...",
        readFailed: "Read failed: {message}",
        readFailedDetail: "Failed to read Provider info: {message}",
        connected: "Connected",
        disconnected: "Disconnected",
        providerMeta: "Models: {modelCount}; Auth: {methodText}",
        actionFailed: "Action failed: {message}",
        oauthLogin: "OAuth Login",
        pending: "Processing...",
        setApiKey: "Set API Key",
        saving: "Saving...",
        clearLogin: "Clear Login",
        clearing: "Clearing...",
        clearTitle: "Clear {providerName} Login",
        clearDesc: "Clear credentials for this Provider?",
        clearSubmit: "Clear",
        clearDone: "Credentials cleared.",
        clearNotice: "{providerName} credentials cleared",
        pickOauthTitle: "Choose OAuth Method for {providerName}",
        pickOauthDesc: "Please choose one OAuth auth method.",
        continue: "Continue",
        invalidOauthMethod: "Invalid OAuth method index",
        oauthCanceled: "OAuth login canceled.",
        oauthCreatingLink: "Creating authorization link...",
        oauthMissingUrl: "Failed to get OAuth authorization URL",
        oauthOpened: "{providerName} authorization page opened",
        oauthCopied: "Cannot open browser automatically. Authorization URL copied to clipboard.",
        oauthCallbackTitle: "{providerName} OAuth Callback",
        oauthCallbackDesc: "Complete authorization in browser and paste the code.",
        oauthCallbackPlaceholder: "Paste authorization code",
        submit: "Submit",
        oauthCodeMissing: "Authorization code is empty. Canceled.",
        oauthCompleteInBrowser: "Complete authorization in browser.",
        oauthThenConfirm: "After completion, click \"Confirm\" to continue.",
        confirm: "Confirm",
        oauthSubmitting: "Submitting OAuth callback...",
        oauthDone: "OAuth login complete.",
        oauthSuccess: "{providerName} login successful",
        apiKeyTitle: "Set {providerName} API Key",
        apiKeyDesc: "Enter Provider API Key (stored only in local FLOWnote credentials).",
        apiKeyPlaceholder: "Enter API Key",
        save: "Save",
        apiKeyCanceled: "API Key setup canceled.",
        apiKeyEmpty: "API Key cannot be empty.",
        apiKeySaving: "Saving API Key...",
        apiKeySaved: "API Key saved.",
        apiKeySavedNotice: "{providerName} API Key saved",
        noAuthMethods: "No auth methods",
      },
    },
    mobile: {
      providers: {
        deepseek: "DeepSeek",
        qwen: "Qwen",
        moonshot: "Moonshot (Kimi)",
        zhipu: "Zhipu (GLM)",
        siliconflow: "SiliconFlow",
        custom: "Custom",
      },
      capture: {
        title: "💡 Quick Capture",
        inputPlaceholder: "What are you thinking now?",
        hintSend: "⌘/Ctrl + Enter to send",
        cancel: "Cancel",
        submit: "Capture",
        submitBusy: "Capturing...",
        statusAiCleanup: "🤖 Cleaning text...",
        statusAiCleanupFailed: "⚠️ AI cleanup failed, using original text",
        statusResolver: "🔗 Resolving URLs...",
        statusResolverFailed: "⚠️ URL resolve failed, fallback to original: {message}",
        statusWriteNote: "📝 Writing daily note...",
        emptyInput: "Please input content.",
      },
      settings: {
        providerName: "AI Provider",
        providerDesc: "Choose a preset provider or custom endpoint.",
        apiKeyName: "API Key",
        apiKeyDesc: "Used for AI cleanup and resolver fallback. Leave empty to skip AI.",
        providerKeyLinkPrefix: "Get key from {name} →",
        baseUrlName: "Base URL (Optional)",
        baseUrlDesc: "Leave empty to use preset. Effective: {value}",
        modelName: "Model (Optional)",
        modelDesc: "Leave empty to use preset. Effective: {value}",
        aiCleanupName: "Enable AI Cleanup",
        aiCleanupDesc: "Automatically removes filler words. Disable to keep original text.",
        urlSummaryName: "Enable URL Resolve",
        urlSummaryDesc: "Use resolver first, then AI fallback, then plain text fallback.",
        resolverSwitchName: "Resolver Master Switch",
        resolverSwitchDesc: "Disable to skip all URL resolver requests.",
        resolverProviderName: "URL Resolver Provider",
        resolverProviderDesc: "Pick one provider. Plugin only uses selected provider.",
        resolverEntryPrefix: "Links:",
        resolverBuyKey: "Get/Buy Key",
        resolverDocs: "API Docs",
        resolverEntrySuffix: ". If page fetch fails, fallback to AI, then plain text.",
        timeoutName: "Timeout (ms)",
        timeoutDesc: "Single resolver request timeout, default 25000.",
        retriesName: "Retry Count",
        retriesDesc: "Retries per provider, default 2.",
        concurrencyName: "Max Concurrency",
        concurrencyDesc: "Max concurrent URL resolves, default 2.",
        dailyPathName: "Daily Note Path",
        dailyPathDesc: "Relative folder path for daily notes.",
        headerName: "Idea Section Header",
        headerDesc: "Section header used for captured ideas.",
        testName: "Test Connection",
        testDesc: "Verify AI service availability.",
        testBtn: "Test",
        testBusy: "Testing...",
      },
      url: {
        statusProviderMissing: "⚠️ {providerName} key missing, fallback to AI",
        statusNoResolverOrAi: "⚠️ Resolver and AI not configured, fallback to plain text",
        statusAiSummary: "🤖 Generating URL summary...",
        statusFallbackAi: "⚠️ {hint}, fallback to AI",
        statusFallbackPlain: "⚠️ {hint}, fallback to plain text",
        statusResolverNoAi: "⚠️ URL resolved but AI not configured, fallback to plain text",
        statusAiSummaryFailed: "⚠️ AI summary failed, fallback to plain text",
        statusPartialResolverFailed: "⚠️ Some URLs failed, partial result applied",
      },
      parser: {
        originalUrlPlaceholder: "OriginalURL",
        originalTextPrefix: "Original",
        summaryFallback: "Unable to resolve, original URL preserved",
        summaryPrefix: "URL Summary",
        linkLabel: "Link {index}",
        untitled: "(Untitled)",
        empty: "(Empty)",
      },
      template: {
        daily: "# {{date}}\n\n## 📋 Today Plan\n- [ ]\n\n## 📝 Today Notes\n\n### 💡 Ideas\n\n### 📖 Learning Notes\n\n## 🔄 Daily Review\n- What I did today:\n- Plan for tomorrow:\n",
        recordHeading: "## 📝 Today Notes",
      },
      prompts: {
        cleanup: "You are a text cleanup assistant. Your only task is to remove filler words from spoken text (such as um, uh, like, you know, etc.) and keep the sentence concise.\nRules:\n1. Only remove filler words\n2. Do not rewrite, polish, or beautify the text\n3. Do not add new content\n4. Keep original meaning and wording\n5. Preserve all substantive content\n6. Preserve all URLs exactly as-is\n7. Return cleaned text only, no explanation",
        urlSummary: "You are a URL summary assistant. User text includes URLs and page content has been fetched.\nOutput the original text unchanged, and append summary lines.\nFormat: each line is `> 📎 OriginalURL - Summary`\nRules:\n- Keep all original URLs unchanged\n- Summary <= 50 chars\n- Do not alter non-URL content\n- If insufficient content, use \"Unable to resolve, original URL preserved\"\n- Return full processed text without explanation",
        urlFallback: "You are a URL fallback assistant.\nTask: apply minimal processing when page content is unavailable.\nRules:\n1. Preserve original text and all URLs exactly\n2. Do not rewrite or fabricate page content\n3. You may only append lines like `> 📎 OriginalURL - Unable to resolve, original URL preserved`\n4. Return processed full text directly",
      },
    },
  },
};

function i18nLookup(locale, key, params = {}, options = {}) {
  const normalizedLocale = normalizeSupportedLocale(locale, DEFAULT_UI_LOCALE);
  const fallbackLocale = normalizeSupportedLocale(options.fallbackLocale || DEFAULT_UI_LOCALE, DEFAULT_UI_LOCALE);
  const defaultValue = Object.prototype.hasOwnProperty.call(options, "defaultValue")
    ? options.defaultValue
    : key;
  const fromLocale = getMessageByPath(I18N_MESSAGES[normalizedLocale], key);
  const fromFallback = getMessageByPath(I18N_MESSAGES[fallbackLocale], key);
  const message = fromLocale !== undefined ? fromLocale : fromFallback !== undefined ? fromFallback : defaultValue;
  if (typeof message !== "string") return String(message);
  return interpolateI18n(message, params);
}

function resolveEffectiveLocaleFromSettings(settings, navigatorLike) {
  const preferred = normalizeUiLanguage(settings && settings.uiLanguage);
  if (preferred === "auto") {
    return resolveLocaleFromNavigator(navigatorLike || (typeof navigator !== "undefined" ? navigator : null), DEFAULT_UI_LOCALE);
  }
  return normalizeSupportedLocale(preferred, DEFAULT_UI_LOCALE);
}

/* =========================================================================
 * Mobile runtime methods are loaded from runtime/mobile/mobile-capture-methods.js
 * ========================================================================= */

/* =========================================================================
 * Plugin class
 * ========================================================================= */

function resolveFacadeModuleAbsolutePath(plugin, relativePath) {
  let fsMod;
  let pathMod;
  try {
    fsMod = require("fs");
    pathMod = require("path");
  } catch (_error) {
    return "";
  }

  const candidates = [];
  if (plugin && plugin.manifest && plugin.manifest.dir) {
    candidates.push(String(plugin.manifest.dir));
  }
  const adapter = plugin && plugin.app && plugin.app.vault ? plugin.app.vault.adapter : null;
  const byMethod = adapter && typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
  const byField = adapter && adapter.basePath ? adapter.basePath : "";
  const basePath = byMethod || byField;
  const configDir = plugin && plugin.app && plugin.app.vault && plugin.app.vault.configDir
    ? String(plugin.app.vault.configDir)
    : ".obsidian";
  const pluginId = plugin && plugin.manifest && plugin.manifest.id
    ? String(plugin.manifest.id)
    : "flownote";
  if (basePath) {
    candidates.push(pathMod.join(basePath, configDir, "plugins", pluginId));
  }
  if (typeof __dirname === "string" && __dirname) {
    candidates.push(__dirname);
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const modulePath = pathMod.join(normalized, "runtime", `${String(relativePath || "").replace(/^\/+/, "")}.js`);
    if (fsMod.existsSync(modulePath)) return modulePath;
  }
  return "";
}

function requireFacadeModule(plugin, relativePath) {
  try {
    switch (relativePath) {
      case "plugin/module-loader-methods":
        return require("./runtime/plugin/module-loader-methods");
      case "plugin/runtime-state-methods":
        return require("./runtime/plugin/runtime-state-methods");
      case "plugin/model-catalog-methods":
        return require("./runtime/plugin/model-catalog-methods");
      case "plugin/bundled-skills-methods":
        return require("./runtime/plugin/bundled-skills-methods");
      case "plugin/session-bootstrap-methods":
        return require("./runtime/plugin/session-bootstrap-methods");
      case "mobile/mobile-capture-methods":
        return require("./runtime/mobile/mobile-capture-methods");
      default:
        throw new Error(`unknown facade module: ${relativePath}`);
    }
  } catch (primaryError) {
    const fallbackPath = resolveFacadeModuleAbsolutePath(plugin, relativePath);
    if (fallbackPath) return requireFacadeModuleFromAbsolutePath(fallbackPath);
    throw primaryError;
  }
}

const OBSIDIAN_REQUIRE_SHIM_KEY = "__flownoteObsidianRequireShim";

function ensureObsidianRequireShim() {
  let moduleLoader = null;
  try {
    moduleLoader = require("module");
  } catch (_error) {
    return false;
  }
  if (!moduleLoader || typeof moduleLoader._load !== "function") return false;
  if (moduleLoader[OBSIDIAN_REQUIRE_SHIM_KEY]) return true;

  const originalLoad = moduleLoader._load;
  const patchedLoad = function patchedLoad(request, parent, isMain) {
    if (request === "obsidian") return obsidianModule;
    return originalLoad.call(this, request, parent, isMain);
  };

  moduleLoader._load = patchedLoad;
  moduleLoader[OBSIDIAN_REQUIRE_SHIM_KEY] = {
    originalLoad,
    patchedLoad,
  };
  return true;
}

function removeObsidianRequireShim() {
  let moduleLoader = null;
  try {
    moduleLoader = require("module");
  } catch (_error) {
    return;
  }
  if (!moduleLoader || typeof moduleLoader._load !== "function") return;

  const state = moduleLoader[OBSIDIAN_REQUIRE_SHIM_KEY];
  if (!state || typeof state !== "object") return;
  if (moduleLoader._load === state.patchedLoad && typeof state.originalLoad === "function") {
    moduleLoader._load = state.originalLoad;
  }
  delete moduleLoader[OBSIDIAN_REQUIRE_SHIM_KEY];
}

function requireFacadeModuleFromAbsolutePath(modulePath) {
  ensureObsidianRequireShim();
  return require(modulePath);
}

class FLOWnoteAssistantPlugin extends Plugin {
  constructor(app, manifest) {
    super(app, manifest);
    this.__pluginFacadeMethodsLoaded = false;
    this.__mobileMethodsLoaded = false;
  }

  getDeviceLocale() {
    return resolveLocaleFromNavigator(typeof navigator !== "undefined" ? navigator : null, DEFAULT_UI_LOCALE);
  }

  getEffectiveLocale() {
    return resolveEffectiveLocaleFromSettings(this.settings || {}, typeof navigator !== "undefined" ? navigator : null);
  }

  t(key, params = {}, options = {}) {
    const locale = options && options.locale ? options.locale : this.getEffectiveLocale();
    return i18nLookup(locale, key, params, options);
  }

  refreshLocaleUi() {
    try {
      setRuntimeLocale(this.getEffectiveLocale());
    } catch {
    }
    try {
      if (typeof this.getAssistantView === "function") {
        const view = this.getAssistantView();
        if (view && typeof view.render === "function") view.render();
      }
    } catch {
    }
  }

  ensureFacadeMethodsLoaded() {
    if (this.__pluginFacadeMethodsLoaded) return;

    const {
      createModuleLoaderMethods,
    } = requireFacadeModule(this, "plugin/module-loader-methods");
    const {
      runtimeStateMethods,
    } = requireFacadeModule(this, "plugin/runtime-state-methods");
    const {
      modelCatalogMethods,
    } = requireFacadeModule(this, "plugin/model-catalog-methods");
    const {
      createBundledSkillsMethods,
    } = requireFacadeModule(this, "plugin/bundled-skills-methods");
    const {
      sessionBootstrapMethods,
    } = requireFacadeModule(this, "plugin/session-bootstrap-methods");

    const moduleLoaderMethods = createModuleLoaderMethods({
      defaultViewType: DEFAULT_VIEW_TYPE,
    });
    const bundledSkillsMethods = createBundledSkillsMethods({
      pluginDirname: this.manifest && this.manifest.dir
        ? String(this.manifest.dir)
        : (typeof __dirname === "string" ? __dirname : ""),
    });

    Object.assign(
      FLOWnoteAssistantPlugin.prototype,
      moduleLoaderMethods,
      runtimeStateMethods,
      modelCatalogMethods,
      bundledSkillsMethods,
      sessionBootstrapMethods,
    );

    this.__pluginFacadeMethodsLoaded = true;
  }

  ensureMobileMethodsLoaded() {
    if (this.__mobileMethodsLoaded) return;
    const { mobileCaptureMethodsMixin } = requireFacadeModule(this, "mobile/mobile-capture-methods");
    Object.assign(
      FLOWnoteAssistantPlugin.prototype,
      mobileCaptureMethodsMixin || {},
    );
    this.__mobileMethodsLoaded = true;
  }

  async onload() {
    if (Platform.isMobile) {
      this.ensureMobileMethodsLoaded();
      await this.onloadMobile();
      return;
    }

    try {
      this.ensureFacadeMethodsLoaded();

      this.runtimeStateMigrationDirty = false;
      this.transportModeMigrationDirty = false;
      this.bootstrapInflight = null;
      this.bootstrapLocalDone = false;
      this.bootstrapRemoteDone = false;
      this.bootstrapRemoteAt = 0;

      const runtime = this.ensureRuntimeModules();
      await this.loadPersistedData();
      setRuntimeLocale(this.getEffectiveLocale());

      this.sessionStore = new runtime.SessionStore(this);

      const vaultPath = this.getVaultPath();
      this.skillService = new runtime.SkillService(vaultPath, this.settings);
      this.opencodeClient = new runtime.FLOWnoteClient({
        vaultPath,
        settings: this.settings,
        logger: (line) => this.log(line),
        getPreferredLaunch: () => this.getPreferredLaunchProfile(),
        onLaunchSuccess: (profile) => this.rememberLaunchProfile(profile),
        SdkTransport: runtime.SdkTransport,
        CompatTransport: runtime.CompatTransport,
      });
      this.diagnosticsService = new runtime.DiagnosticsService(this, runtime.ExecutableResolver);

      this.registerView(this.getViewType(), (leaf) => new runtime.FLOWnoteAssistantView(leaf, this));

      this.addRibbonIcon("bot", "FLOWnote", () => this.activateView());

      this.addCommand({
        id: "open-flownote",
        name: this.t("commands.open"),
        callback: () => this.activateView(),
      });

      this.addCommand({
        id: "flownote-send-selected-text",
        name: this.t("commands.sendSelectedText"),
        editorCallback: async (editor) => {
          const text = editor.getSelection().trim();
          if (!text) return new Notice(this.t("notices.pickTextFirst"));

          await this.activateView();
          const view = this.getAssistantView();
          if (view) await view.sendPrompt(text);
        },
      });

      this.addCommand({
        id: "flownote-new-session",
        name: this.t("commands.newSession"),
        callback: async () => {
          const session = await this.createSession("");
          this.sessionStore.setActiveSession(session.id);
          await this.persistState();
          const view = this.getAssistantView();
          if (view) view.render();
        },
      });

      this.addSettingTab(new runtime.FLOWnoteSettingsTab(this.app, this));
      await this.bootstrapData({ waitRemote: false });
      if (this.runtimeStateMigrationDirty || this.transportModeMigrationDirty) {
        this.runtimeStateMigrationDirty = false;
        this.transportModeMigrationDirty = false;
        void this.persistState().catch((e) => {
          this.log(`persist migrated runtime state failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[FLOWnote] load failed", e);
      new Notice(this.t("notices.pluginLoadFailed", { message: msg }));
    }
  }

  async onunload() {
    if (this.opencodeClient) await this.opencodeClient.stop();
    if (typeof this.getViewType === "function") {
      this.app.workspace.detachLeavesOfType(this.getViewType());
    }
    removeObsidianRequireShim();
  }

  log(line) {
    if (!this.settings || !this.settings.debugLogs) return;
    console.log("[FLOWnote]", line);
  }

  getVaultPath() {
    const adapter = this.app.vault.adapter;
    const byMethod = adapter && typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
    const byField = adapter && adapter.basePath ? adapter.basePath : "";
    const resolved = byMethod || byField;
    if (!resolved) throw new Error(this.t("errors.localFsOnly"));
    return resolved;
  }

  /* --- Mobile-only compatibility wrappers --- */

  async _onloadMobile() {
    this.ensureMobileMethodsLoaded();
    if (typeof this.onloadMobile === "function") {
      await this.onloadMobile();
    }
  }

  _openCaptureModal() {
    this.ensureMobileMethodsLoaded();
    if (typeof this.openCaptureModal === "function") {
      this.openCaptureModal();
    }
  }

  async _loadMobileData() {
    this.ensureMobileMethodsLoaded();
    if (typeof this.loadMobilePersistedData === "function") {
      await this.loadMobilePersistedData();
    }
  }

  async saveSettings() {
    // On desktop this method is overridden by the session-bootstrap mixin.
    // This fallback runs on mobile and remains compatible with mixin methods.
    if (Platform.isMobile && typeof this.saveMobileSettings === "function") {
      await this.saveMobileSettings();
      return;
    }
    const raw = (await this.loadData()) || {};
    raw.settings = this.settings;
    await this.saveData(raw);
    setRuntimeLocale(this.getEffectiveLocale());
  }
}

module.exports = FLOWnoteAssistantPlugin;

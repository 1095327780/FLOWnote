const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("clickable home cards and heatmap cells have keyboard semantics", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../runtime/view/layout/home-methods.js"), "utf8");
  assert.match(source, /function bindKeyboardActivation/);
  assert.match(source, /setAttr\("role", "button"\)/);
  assert.match(source, /setAttr\("tabindex", "0"\)/);
  assert.match(source, /const projectMain = item\.createDiv\(\{ cls: "oc-home-project-main" \}\)/);
  assert.match(source, /bindKeyboardActivation\(\s*projectMain,/);
  assert.doesNotMatch(source, /bindKeyboardActivation\(\s*item,/);
  assert.match(source, /createEl\("button",\s*\{\s*cls: `oc-home-task-row/);
  assert.doesNotMatch(source, /row\.setAttr\("role", "checkbox"\)/);
  assert.match(source, /grid\.createEl\("button",\s*\{\s*cls:\s*`\$\{cellClass\} is-clickable`/);
  assert.doesNotMatch(source, /bindKeyboardActivation\(square,/);
});

test("home project cards avoid nesting a chat button inside their keyboard-activated open target", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../runtime/view/layout/home-methods.js"), "utf8");
  const projectCard = source.slice(source.indexOf("function renderProjectCard"), source.indexOf("function heatmapLevel"));
  assert.match(projectCard, /const projectMain = item\.createDiv\(\{ cls: "oc-home-project-main" \}\)/);
  assert.match(projectCard, /const chatBtn = item\.createEl\("button", \{ cls: "oc-home-project-chat" \}\)/);
  assert.doesNotMatch(projectCard, /const chatBtn = tags\.createEl\("button"/);
});

test("home notices resolve stable translation keys instead of translated text as a key", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../runtime/view/layout/home-methods.js"), "utf8");
  assert.match(source, /homeText\(view, "fileMissing", "文件不存在"\)/);
  assert.match(source, /homeText\(view, "openFileUnsupported", "当前设备暂不支持从首页打开文件"\)/);
  assert.doesNotMatch(source, /homeText\(view,\s*tr\(/);
});

test("mobile home has one complete, non-cropping presentation contract", () => {
  const css = fs.readFileSync(path.join(__dirname, "../../styles.css"), "utf8");
  const start = css.indexOf("/* Mobile home — canonical presentation");
  const end = css.indexOf("/* Final mobile capture overrides", start);
  assert.ok(start >= 0 && end > start, "canonical mobile home block must exist");
  assert.doesNotMatch(
    css.slice(0, start),
    /\.is-mobile \.oc-home(?:\b|-)/,
    "superseded mobile Home presentation rules must be removed, not layered underneath",
  );
  const mobileHome = css.slice(start, end);

  assert.match(mobileHome, /\.is-mobile \.oc-home-stats[^\{]*\{[\s\S]{0,300}display:\s*grid;[\s\S]{0,180}grid-template-columns:\s*repeat\(6, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(mobileHome, /\.oc-home-stats[\s\S]{0,260}overflow-x:\s*auto/);
  assert.match(mobileHome, /\.is-mobile \.oc-home-hero-text[^\{]*\{[\s\S]{0,180}display:\s*block/);
  assert.match(mobileHome, /\.is-mobile \.oc-home-hero-date[^\{]*\{[\s\S]{0,180}display:\s*flex/);
  assert.match(mobileHome, /\.oc-home-action-grid-hero[^\{]*\{[\s\S]{0,260}grid-template-columns:\s*44px repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(mobileHome, /\.oc-home-action[^\{]*\{[\s\S]{0,240}min-height:\s*44px/);
  assert.doesNotMatch(css, /oc-home-actions-card-top/);
  assert.match(css, /\.oc-home-heatmap-grid button\.oc-home-heatmap-cell\s*\{[\s\S]{0,220}min-width:\s*0;[\s\S]{0,100}min-height:\s*0;[\s\S]{0,120}box-shadow:\s*none/);
  assert.match(css, /\.is-mobile \.oc-text-copy-btn,[\s\S]{0,500}opacity:\s*1/);
  assert.match(css, /\.is-mobile \.oc-code-copy-btn[\s\S]{0,500}min-height:\s*44px/);
  assert.match(css, /\.is-mobile \.oc-context-file-picker-item[\s\S]{0,500}min-height:\s*44px/);
});

test("today card omits progress chrome and the boxed task list when there are no tasks", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../runtime/view/layout/home-methods.js"), "utf8");
  const todayCard = source.slice(source.indexOf("function renderTodayCard"), source.indexOf("function renderProjectCard"));
  assert.match(todayCard, /card\.toggleClass\("has-tasks", taskItems\.length > 0\)/);
  assert.match(todayCard, /if \(taskItems\.length > 0\) \{[\s\S]*renderTodayTasks/);
  assert.match(todayCard, /oc-home-task-empty-inline/);
});

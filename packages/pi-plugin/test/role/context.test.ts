// 上下文隔离的离线测试：标记剥离、主代理专属注入，以及「哪一半在哪个会话生效」。
//
// 三个入口按加载方式区分受众，所以这里逐个入口验：主会话（无环境变量）、后台子代理
// （PI_SUBAGENT_CHILD=1）、以及只靠入口区分的前台子代理。

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ContextFile, EventHandler, ExtensionModule, FakeExtensionApi, PromptOptions, SessionContext } from "../types.ts";

const here = new URL(".", import.meta.url);
const src = (name: string): string => pathToFileURL(join(here.pathname, "..", "..", "src", name)).href;

const { stripMarkedSections, injectMainOnly, MAIN_ONLY_FILE } = await import(src("context-scope.ts"));
const mainContext = await import(src("main-context.ts"));
const childContext = await import(src("child-context.ts"));
const activateMain = mainContext.default as ExtensionModule["activate"];
const activateChild = childContext.default as ExtensionModule["activate"];

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ok   ${label}`);
}

/** 一个临时的项目目录，用来放 .pi/main-only.md。 */
function project(mainOnlyText?: string): string {
  const dir = join(tmpdir(), `pi-subagents-extend-ctx-${process.pid}-${(Math.random() * 1e6) | 0}`);
  mkdirSync(join(dir, ".pi"), { recursive: true });
  if (mainOnlyText !== undefined) writeFileSync(join(dir, MAIN_ONLY_FILE), mainOnlyText);
  return dir;
}

const AGENTS = [
  "# 仓库约定",
  "",
  "Token shared to everyone: SHARED_ALPHA",
  "",
  "<!-- main-agent-only:start -->",
  "Token only for the main agent: MARK_MAIN_ONLY_A",
  "<!-- main-agent-only:end -->",
  "",
  "## 验收",
  "",
  "mise run test 全绿",
  "",
].join("\n");

/** 造一个 pi，只收集 before_agent_start；返回给 handler 用的 ctx。 */
interface HarnessResult {
  notes: { message: string; level?: string }[];
  turn(cwd: string, contextFiles?: ContextFile[]): PromptOptions;
}

function harness(activate: ExtensionModule["activate"]): HarnessResult {
  const handlers: Record<string, EventHandler> = {};
  const notes: { message: string; level?: string }[] = [];
  const api: FakeExtensionApi = {
    on(event, fn) {
      handlers[event] = fn;
    },
    registerCommand() {},
  };
  activate(api);
  assert.ok(handlers.before_agent_start, "before_agent_start 必须被注册");
  return {
    notes,
    /** 跑一轮，返回它看到的 systemPromptOptions。 */
    turn(cwd: string, contextFiles?: { path: string; content: string }[]) {
      const options: PromptOptions = contextFiles ? { contextFiles } : {};
      const ctx: SessionContext = { cwd, ui: { notify: (message: string, level?: string) => notes.push({ message, level }) } };
      handlers.before_agent_start({ systemPromptOptions: options }, ctx);
      return options;
    },
  };
}

/** 一份全新的 contextFiles，避免测试之间互相污染（剥离是就地改）。 */
const files = () => [{ path: "/proj/AGENTS.md", content: AGENTS }];

/** 用环境变量模拟后台子代理。 */
function asBackgroundChild<T>(fn: () => T): T {
  const previous = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = "1";
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previous;
  }
}

/** 用主会话语义跑一个用例：清掉后台标记，退出时恢复调用方的环境。 */
function asMainSession<T>(fn: () => T): T {
  const previous = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previous;
  }
}

console.log("pi-subagents-extend context");

// 1. 成对标记整段剥离，其余内容逐字保留。
{
  const list = files();
  const result = stripMarkedSections(list);
  assert.equal(list[0].content.includes("MARK_MAIN_ONLY_A"), false, "标记段被删掉");
  assert.equal(list[0].content.includes("SHARED_ALPHA"), true, "共享段落保留");
  assert.equal(list[0].content.includes("mise run test 全绿"), true, "标记之后的内容保留");
  assert.equal(list[0].content.includes("<!-- main-agent-only:end -->"), false, "标记本身也删掉");
  assert.equal(result.files, 1);
  assert.ok(result.removedChars > 0);
  assert.deepEqual(result.unbalanced, []);
  ok("成对标记整段剥离，前后内容逐字保留");
}

// 2. 没有标记的文件一个字都不动。
{
  const plain = [{ path: "/proj/README.md", content: "# 没有标记\n" }];
  const result = stripMarkedSections(plain);
  assert.equal(plain[0].content, "# 没有标记\n");
  assert.equal(result.files, 0);
  assert.equal(result.removedChars, 0);
  ok("没有标记的文件不动");
}

// 3. 标记不闭合时整段保留，并报告出来。
{
  const broken = [{ path: "/proj/AGENTS.md", content: "前\n<!-- main-agent-only:start -->\n只给主代理\n" }];
  const result = stripMarkedSections(broken);
  assert.match(broken[0].content, /只给主代理/, "不闭合时不能删内容");
  assert.deepEqual(result.unbalanced, ["/proj/AGENTS.md"]);
  assert.equal(result.files, 0);
  ok("标记不闭合 → 整段保留 + 报告，不猜边界");
}

// 4. contextFiles 缺省时不炸。
{
  const result = stripMarkedSections(undefined);
  assert.equal(result.files, 0);
  assert.deepEqual(result.unbalanced, []);
  ok("没有 contextFiles 时不炸");
}

// 5. 主代理专属文件注入成 section。
{
  const dir = project("Token only for the main agent: MAINFILE_B\n");
  const options: PromptOptions = {};
  const injected = injectMainOnly(options, dir);
  assert.ok(injected > 0, "有文件就注入");
  assert.equal(options.sections?.main_only_instructions?.includes("MAINFILE_B"), true);
  assert.equal("sections" in options, true);
  rmSync(dir, { recursive: true, force: true });
  ok(".pi/main-only.md 注入成 section");
}

// 6. 没有那个文件就什么都不做（不改 sections）。
{
  const dir = project(undefined);
  const options: PromptOptions = {};
  assert.equal(injectMainOnly(options, dir), 0);
  assert.equal(options.sections, undefined, "没有文件不该凭空造 sections");
  rmSync(dir, { recursive: true, force: true });
  ok("没有 .pi/main-only.md 时不动 sections");
}

// 7. 主会话：注入主代理专属内容，标记段原样保留（主代理本来就该看见）。
{
  const dir = project("MAINFILE_B\n");
  const h = harness(activateMain);
  const options = asMainSession(() => h.turn(dir, files()));
  assert.equal(options.sections?.main_only_instructions?.includes("MAINFILE_B"), true, "主会话拿到注入");
  assert.equal(options.contextFiles?.[0]?.content.includes("MARK_MAIN_ONLY_A"), true, "主会话不剥标记");
  assert.deepEqual(h.notes, [], "正常情况不打扰用户");
  rmSync(dir, { recursive: true, force: true });
  ok("主会话：注入主代理专属文件，不剥标记");
}

// 8. 后台子代理：环境扩展也加载，所以必须剥标记、且不注入。
{
  const dir = project("MAINFILE_B\n");
  const h = harness(activateMain);
  const options = asBackgroundChild(() => h.turn(dir, files()));
  assert.equal(options.contextFiles?.[0]?.content.includes("MARK_MAIN_ONLY_A"), false, "后台子代理剥掉标记");
  assert.equal(options.sections, undefined, "后台子代理不注入主代理专属内容");
  rmSync(dir, { recursive: true, force: true });
  ok("后台子代理（PI_SUBAGENT_CHILD=1）：剥标记且不注入");
}

// 9. 前台子代理：只声明 child-context，没有环境变量也要剥。
{
  const dir = project("MAINFILE_B\n");
  const h = harness(activateChild);
  const options = asMainSession(() => h.turn(dir, files()));
  assert.equal(options.contextFiles?.[0]?.content.includes("MARK_MAIN_ONLY_A"), false, "前台子代理剥掉标记");
  assert.equal(options.sections, undefined, "前台子代理不注入");
  rmSync(dir, { recursive: true, force: true });
  ok("前台子代理（无环境变量、靠入口区分）：剥标记且不注入");
}

// 10. 标记坏了要在会话里说一声，而不是静默放过。
{
  const dir = project(undefined);
  const h = harness(activateChild);
  const broken = [{ path: "/proj/AGENTS.md", content: "<!-- main-agent-only:start -->\n漏了闭合\n" }];
  h.turn(dir, broken);
  assert.equal(h.notes.length, 1, "应当有一条提示");
  assert.match(h.notes[0].message, /unclosed/);
  assert.match(h.notes[0].message, /AGENTS\.md/);
  assert.equal(h.notes[0].level, "warning");
  rmSync(dir, { recursive: true, force: true });
  ok("标记不闭合时给出 warning");
}

console.log(`\npi-subagents-extend context 测试通过（${passed} 项）`);

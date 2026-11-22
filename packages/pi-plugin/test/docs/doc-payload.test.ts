// 文档里展示的 bindings 载荷必须仍能被 reader 接受：文档和 reader 不能各自漂移。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CommandSpec, EventHandler, ExtensionModule, FakeExtensionApi, SessionContext } from "../types.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../../..", import.meta.url));
const src = (name: string): string => pathToFileURL(join(here, "..", "..", "src", name)).href;

// extractCallConfig 没有导出，所以用环境变量走完整 reader：激活后用 /permission 看它解析出的策略。
const { activate } = (await import(src("index.ts"))) as unknown as ExtensionModule;
// 权限键集合从 reader 自己导出，不在测试里抄一份：reader 增删键时这里跟着动。
const { POLICY_CONFIG_KEYS, PAYLOAD_IGNORED_KEYS } = (await import(src("policy/index.ts"))) as unknown as {
  POLICY_CONFIG_KEYS: readonly string[];
  PAYLOAD_IGNORED_KEYS: readonly string[];
};
const { bindingKey } = (await import(src("role-config.ts"))) as unknown as { bindingKey(): string };
const PERMISSION_KEYS = new Set<string>([...POLICY_CONFIG_KEYS, ...PAYLOAD_IGNORED_KEYS]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".build", "target"]);
const skipped = (rel: string): boolean =>
  rel.split(sep).some((part) => SKIP_DIRS.has(part) || part.includes("pi-worktree"));

const markdownFiles: string[] = [];
const walk = (absolute: string, rel: string): void => {
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (skipped(childRel)) continue;
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) walk(child, childRel);
    else if (entry.isFile() && entry.name.endsWith(".md")) markdownFiles.push(child);
  }
};
walk(root, "");

interface Block {
  file: string
  line: number
  text: string
}

const blocks: Block[] = [];
for (const file of markdownFiles) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  let open: number | undefined;
  let body: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (/^\s*```/.test(line)) {
      if (open === undefined) {
        open = index + 1;
        body = [];
      } else {
        blocks.push({ file, line: open, text: body.join("\n") });
        open = undefined;
        body = [];
      }
      continue;
    }
    if (open !== undefined) body.push(line);
  }
}

interface JsonObject {
  json: string
  value: Record<string, unknown>
}

/**
 * 花括号配平后交给 JSON.parse：散文或残缺示例解析不出来就跳过。
 * 同一个扫描器同时喂命名空间载荷和裸权限对象，避免两套提取规则各自漂移。
 */
function jsonObjects(block: string): JsonObject[] {
  const found: JsonObject[] = [];
  for (let start = 0; start < block.length; start += 1) {
    if (block[start] !== "{") continue;
    let depth = 0;
    let quote: string | undefined;
    for (let i = start; i < block.length; i += 1) {
      const ch = block[i] as string;
      if (quote) {
        if (ch === "\\") {
          i += 1;
          continue;
        }
        if (ch === quote) quote = undefined;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth !== 0) continue;
        const candidate = block.slice(start, i + 1);
        try {
          const parsed: unknown = JSON.parse(candidate);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            found.push({ json: candidate, value: parsed as Record<string, unknown> });
          }
        } catch {
          // 不是 JSON：散文块，跳过。
        }
        break;
      }
    }
  }
  return found;
}

function bindingPayload(block: string): string | undefined {
  return jsonObjects(block).find(({ value }) =>
    Object.keys(value).some((key) => key.startsWith("pi-subagents-extend/"))
  )?.json;
}

type ExampleKind = "payload" | "bare" | "unknown-key";

interface Payload extends Block {
  json: string
  kind: ExampleKind
  permissions: Record<string, unknown>
}

// 文档里的 allow 列必须真的能跑：取第一条普通命令（re: 只是模式，不是命令）。
function firstPlainAllowCommand(json: string): string | undefined {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const ns = value as { permissions?: { bash?: { allow?: unknown } } };
    const allow = ns.permissions?.bash?.allow;
    if (!Array.isArray(allow)) continue;
    const command = allow.find(
      (entry: unknown): entry is string =>
        typeof entry === "string" && entry.trim().length > 0 && !entry.trimStart().startsWith("re:"),
    );
    if (command) return command;
  }
  return undefined;
}

// 只有带引号的命名空间键、且块里真的有花括号才可能是派单载荷：裸路径（import、frontmatter、--spec）
// 按语义排除，不再用 file:line 豁免表——文档一换行，豁免就会静默漏检。没有 `{` 的块不可能是 JSON 载荷。
const NAMESPACE_KEY = /["']pi-subagents-extend\/[0-9]+["']/;
/** 从整份派单载荷里取出 permissions 对象；裸对象本身就是 permissions。 */
function permissionsOf(jsonObjectsInBlock: JsonObject[]): Record<string, unknown> | undefined {
  for (const { value } of jsonObjectsInBlock) {
    for (const ns of Object.values(value)) {
      if (ns && typeof ns === "object" && !Array.isArray(ns) && Object.hasOwn(ns, "permissions")) {
        const perms = (ns as { permissions: unknown }).permissions;
        if (perms && typeof perms === "object" && !Array.isArray(perms)) {
          return perms as Record<string, unknown>;
        }
      }
    }
  }
  return undefined;
}

/** reader 仍接受 legacy 列，所以文档示例要靠这条规则拦，不能靠「reader 是否接受」。 */
function legacyBashColumns(permissions: Record<string, unknown>): string[] {
  const bash = permissions.bash;
  if (!bash || typeof bash !== "object" || Array.isArray(bash)) return [];
  return ["read", "write"].filter((column) => Object.hasOwn(bash, column));
}


const payloads: Payload[] = [];
const skippedBlocks: string[] = [];
const bareObjects: Payload[] = [];
const unknownKeyObjects: Payload[] = [];
const legacyColumns: string[] = [];
const wrap = (permissions: Record<string, unknown>): string =>
  JSON.stringify({ [bindingKey()]: { permissions } });
const describe = (example: Payload): string =>
  `${relative(root, example.file)}:${example.line} (${example.kind})`;

for (const block of blocks) {
  const objects = block.text.includes("{") ? jsonObjects(block.text) : [];
  if (NAMESPACE_KEY.test(block.text)) {
    const json = bindingPayload(block.text);
    if (!json) {
      skippedBlocks.push(`${relative(root, block.file)}:${block.line}`);
      continue;
    }
    const permissions = permissionsOf(objects);
    const example: Payload = { ...block, json, kind: "payload", permissions: permissions ?? {} };
    payloads.push(example);
    const columns = legacyBashColumns(example.permissions);
    if (columns.length > 0) legacyColumns.push(`${describe(example)}: bash.${columns.join(" and bash.")}`);
    continue;
  }
  // 裸权限对象：整个对象就是 permissions；两个键以上、且至少有一个 reader 认识的键，
  // 才不会被文档里随便一个 JSON 例子误收。键全在 reader 的白名单里才算示例，
  // 多出一个未知键的「长得像权限」的块也照样包起来交给 reader，让它把拒绝原因报出来。
  const candidate = objects.find(({ value }) => {
    const keys = Object.keys(value);
    return keys.length >= 2 && keys.some((key) => PERMISSION_KEYS.has(key));
  });
  if (!candidate) continue;
  const keys = Object.keys(candidate.value);
  const kind: ExampleKind = keys.every((key) => PERMISSION_KEYS.has(key)) ? "bare" : "unknown-key";
  const example: Payload = {
    ...block,
    json: wrap(candidate.value),
    kind,
    permissions: candidate.value,
  };
  const columns = legacyBashColumns(example.permissions);
  if (columns.length > 0) legacyColumns.push(`${describe(example)}: bash.${columns.join(" and bash.")}`);
  if (kind === "bare") bareObjects.push(example);
  else unknownKeyObjects.push(example);
}
// 每个带引号命名空间键的围栏块都应当是载荷；一次报齐解析不出来的块，而不是静默跳过。
assert.equal(
  skippedBlocks.length,
  0,
  `${skippedBlocks.length} fenced blocks carry a quoted pi-subagents-extend/N key but no binding payload:\n${skippedBlocks.join("\n")}`,
);

console.log(
  `documented examples: namespaced payloads ${payloads.length}, bare permission objects ${bareObjects.length}, total ${payloads.length + bareObjects.length} (unknown-key permission-like blocks ${unknownKeyObjects.length})`,
);

const MIN_PAYLOADS = 6;
assert.ok(
  payloads.length >= MIN_PAYLOADS,
  `only ${payloads.length} documented binding payloads; expected at least ${MIN_PAYLOADS} — a payload left coverage, fix the extraction rather than lowering the floor`,
);
const MIN_BARE = 1;
assert.ok(
  bareObjects.length >= MIN_BARE,
  `only ${bareObjects.length} documented bare permission objects; expected at least ${MIN_BARE} — the extraction lost them, fix it rather than lowering the floor`
);

const refusals: string[] = [];
const writeRefusals: string[] = [];
let writeChecked = 0;
let toolCallSeq = 0;
const checkedExamples: Payload[] = [...payloads, ...bareObjects, ...unknownKeyObjects];
for (const payload of checkedExamples) {
  const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
  process.env.PI_SUBAGENT_EXTENSION_BINDINGS = payload.json;
  const commands: Record<string, CommandSpec> = {};
  const handlers: Record<string, EventHandler> = {};
  const notices: string[] = [];
  const api: FakeExtensionApi = {
    on(event, handler) {
      handlers[event] = handler;
    },
    registerCommand(name, spec) {
      commands[name] = spec;
    },
  };
  try {
    activate(api);
    const permission = commands.permission;
    assert.ok(permission, "the extension registers /permission");
    const ctx: SessionContext = { cwd: root, ui: { notify(message) { notices.push(message); } } };
    await permission.handler("", ctx);
    const printed = notices.join("\n");
    if (printed.includes("everything is refused")) {
      // 不立刻 fail：把所有 refused 的块一次报齐，父代理不用逐个重跑。
      refusals.push(`${describe(payload)}: ${printed}`);
    }
    const command = firstPlainAllowCommand(payload.json);
    if (command) {
      writeChecked += 1;
      const verdict = (await handlers.tool_call?.(
        { type: "tool_call", toolCallId: `doc-${++toolCallSeq}`, toolName: "bash", input: { command } },
        ctx,
      )) as { reason?: unknown } | undefined;
      const reason = typeof verdict?.reason === "string" ? verdict.reason : "";
      if (reason.includes("bash.writable: false gives no write access")) {
        writeRefusals.push(`${describe(payload)}: ${command}`);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
    else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previous;
  }
}

assert.equal(
  refusals.length,
  0,
  `${refusals.length}/${checkedExamples.length} documented payloads/permission objects were refused by the reader; the docs and the reader disagree:\n${refusals.join("\n---\n")}`,
);
assert.ok(writeChecked > 0, "no documented payload has a bash.allow command to exercise");
assert.equal(
  writeRefusals.length,
  0,
  `${writeRefusals.length}/${writeChecked} documented bash.allow commands were refused as writes:\n${writeRefusals.join("\n")}`,
);

// legacy 列 reader 仍接受（只告警），所以 acceptance 之外还要单独拦文档示例。
assert.equal(
  legacyColumns.length,
  0,
  `${legacyColumns.length} documented examples still teach a legacy bash column; replace the column with "bash": { "allow": [...] } (read/write is judged internally):\n${legacyColumns.join("\n")}`,
);

console.log(
  `reader checks: refused ${refusals.length}, bash.allow commands exercised ${writeChecked}, write-refused ${writeRefusals.length}, legacy bash columns ${legacyColumns.length}`,
);
console.log("documented binding payload tests passed");

// 角色 md 层的真派单覆盖：extend 必须真的作用到子会话，交付物落在主检出，
// setup.preExec 在子会话动手前跑一次。沿用 dispatch-payload 的分流方式：
// mock 按 systemPrompt 区分父/子会话，真 pi 会话跑完再断言父会话的 subagent
// 工具结果、mock 请求体（子提示词）与主检出的真实文件。
//
//   scope：      越界读被拒，拒因点名 role md；范围内读放行并回流；
//   deliverable：子提示词带短路径；写入落在主检出，隔壁文件仍被拒；
//   preExec：    标记文件在第一次工具调用前就存在，且只写了一次。
//
// 单独跑：node test/e2e-role.test.ts（包目录内）

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { piDriver } from "../hosts/pi.ts";
import type { HostRun } from "../hosts/types.ts";
import { loadMockFixture } from "../mock-fixture.ts";
import { startMockLlmFromFixture, type MockLlm } from "../mock-llm.ts";
import { stateDir } from "../state-dir.ts";

const PKG_DIR = fileURLToPath(new URL("../..", import.meta.url));
const EXT = join(PKG_DIR, "src", "index.ts");
const FIXTURES = join(PKG_DIR, "test", "fixtures", "mock");
const KEEP = process.env.PI_MOCK_KEEP === "1";
// 真会话要跑两轮（父派单 + 子执行），按单会话预算的两倍放宽。
const TIMEOUT_MS = Number(process.env.PI_MOCK_TIMEOUT_MS ?? 120_000);

/** 临时根走 test/state-dir.ts 的共享 scratch 约定（受限子代理的写授权覆盖 .test-state）。 */
function tempRoot(prefix: string): string {
  return stateDir(prefix, `.test-${prefix}`);
}

/**
 * 探针工程：in-scope.txt 在范围内，outside/out-of-scope.txt 在范围外。
 * 角色 md 只挂本扩展，正文带角色名以命中场景的子会话谓词。
 */
function makeProject(
  role: string,
  md: string[],
  options: { commit?: boolean } = {},
): string {
  const root = tempRoot("pi-role-");
  // 交付物接线按「主检出锚点」找仓库根。探针工程落在共享 .test-state 里就在工作树
  // 仓库之内，git 会把锚点定位到真主检出，交付物就写进开发者的检出；git init 让
  // 探针工程自己是独立仓库，锚点回到工程本身——与落在 ~/tmp 时「无 git 证据 →
  // 回退 cwd」的行为一致。
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "in-scope.txt"), "IN-SCOPE-OK\n");
  mkdirSync(join(root, "outside"), { recursive: true });
  writeFileSync(join(root, "outside", "out-of-scope.txt"), "OUT-OF-SCOPE-LEAK\n");
  mkdirSync(join(root, ".pi", "agents"), { recursive: true });
  writeFileSync(join(root, ".pi", "agents", `${role}.md`), md.join("\n"));
  if (options.commit) {
    // 角色 md 故意不提交：`git worktree add` 只带 tracked 文件，工作树副本里就没有 md。
    // 这条用例要证的是「工作树里找不到 md 时，仍能从主检出定位到它」——md 若跟着进了
    // 工作树，旧实现（只在 cwd 向上走）也会通过，用例就钉不住修复。
    // 其余文件必须提交：没有 HEAD 时 pi-subagents 建不出工作树。
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(join(root, ".git", "info", "exclude"), `.pi/agents/${role}.md\n`);
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: root, stdio: "ignore" });
    };
    git("add", "-A");
    git("-c", "user.email=probe@example.invalid", "-c", "user.name=probe", "commit", "-q", "-m", "probe");
  }
  return root;
}

/** 隔离的 agent 目录：models.json 把 provider `mock` 指到 mock 服务。 */
function makeAgentDir(mockUrl: string): string {
  const dir = tempRoot("pi-role-agent-");
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify(
      {
        providers: {
          mock: {
            baseUrl: mockUrl,
            api: "openai-completions",
            apiKey: "mock-key",
            models: [{ id: "mock-1", contextWindow: 128_000, maxTokens: 8192 }],
          },
        },
      },
      null,
      2,
    ),
  );
  return dir;
}

interface CaseOutcome {
  run: HostRun;
  subagent: { tool?: string; text: string };
  mock: MockLlm;
  files: Record<string, { exists: boolean; content?: string }>;
  /** 探针工程根目录：工作树用例要证明子会话的 cwd 不是它。 */
  project: string;
}

/** 会话的系统提示文本；mock 的请求体里只有消息数组，没有端口以外的元数据。 */
function systemText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages
    .filter((message): message is Record<string, unknown> =>
      typeof message === "object" && message !== null)
    .filter((message) => message.role === "system")
    .map((message) => typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content))
    .join("\n");
}

/** 跑一个场景：mock 分流 + 临时工程 → 真 pi 会话 → 父会话的 subagent 结果。 */
async function runCase(
  fixture: string,
  prompt: string,
  role: string,
  md: string[],
  probes: string[] = [],
  options: { commit?: boolean } = {},
): Promise<CaseOutcome> {
  const mock = await startMockLlmFromFixture(
    loadMockFixture(join(FIXTURES, fixture)),
  );
  const project = makeProject(role, md, options);
  const agentDir = makeAgentDir(mock.url);
  let run: HostRun | undefined;
  try {
    run = await piDriver.run({
      project,
      mockUrl: mock.url,
      agentDir,
      prompt,
      timeoutMs: TIMEOUT_MS,
    });
    const tail = run.stderr.slice(-800);
    const subagent = run.toolResults.find((r) => r.tool === "subagent");
    assert.ok(
      subagent,
      `the parent's subagent call produced no tool result — the role md may not have loaded in the child, or the session crashed. stderr: ${tail}`,
    );
    // 文件状态在清理前取快照：断言仍可用 run.stderr 说明失败现场。
    const files: Record<string, { exists: boolean; content?: string }> = {};
    for (const rel of probes) {
      const abs = join(project, rel);
      files[rel] = existsSync(abs)
        ? { exists: true, content: readFileSync(abs, "utf8") }
        : { exists: false };
    }
    return { run, subagent, mock, files, project };
  } finally {
    if (run) await run.stop();
    await mock.stop();
    if (!KEEP) {
      rmSync(project, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    }
  }
}

const HEAD = (text: string): string => `result head: ${JSON.stringify(text.slice(0, 300))}`;
const tailOf = (run: HostRun): string => `stderr: ${run.stderr.slice(-800)}`;

// 1. 角色 md 的 extend.permissions 是唯一范围来源：越界读被拒且点名 role md。
{
  const { run, subagent } = await runCase(
    "role-scope.yaml",
    "Go.",
    "role-scope",
    [
      "---",
      "name: role-scope",
      "description: Role md layer scope probe",
      "inheritSkills: false",
      "inheritProjectContext: true",
      "tools: read, write",
      `subagentOnlyExtensions: "${EXT}"`,
      "extend:",
      "  permissions:",
      "    scope:",
      "      - in-scope.txt",
      "---",
      "",
      "You are role-scope: quote file contents verbatim.",
      "",
    ],
  );
  const tail = tailOf(run);
  assert.ok(
    subagent.text.includes("outside the read scope"),
    `the role md's scope must refuse the child's out-of-scope read. ${HEAD(subagent.text)} ${tail}`,
  );
  assert.ok(
    subagent.text.includes("role md "),
    `the refusal must name the role md as its source. ${HEAD(subagent.text)} ${tail}`,
  );
  assert.ok(
    subagent.text.includes("role-scope.md"),
    `the refusal must name this role's md file, not just a generic layer. ${HEAD(subagent.text)} ${tail}`,
  );
  assert.equal(
    subagent.text.includes("extensionBindings"),
    false,
    `no dispatch payload was sent, so the refusal must not blame extensionBindings. ${HEAD(subagent.text)} ${tail}`,
  );
  assert.equal(
    subagent.text.includes("OUT-OF-SCOPE-LEAK"),
    false,
    `a refused read must not leak the file's content. ${HEAD(subagent.text)} ${tail}`,
  );
  assert.ok(
    subagent.text.includes("IN-SCOPE-OK"),
    `positive control: the same scope must permit the in-scope read and carry its content back. ${HEAD(subagent.text)} ${tail}`,
  );
  console.log("  ok   role md 范围：越界读被拒且点名 role md，范围内读回流");
}

// 2. extend.output.deliverable：提示词含短路径，真实文件落在主检出，隔壁被拒。
{
  const { run, subagent, mock, files, project } = await runCase(
    "role-deliverable.yaml",
    "Go.",
    "role-deliverable",
    [
      "---",
      "name: role-deliverable",
      "description: Role md layer deliverable probe",
      "inheritSkills: false",
      "inheritProjectContext: true",
      "tools: read, write",
      `subagentOnlyExtensions: "${EXT}"`,
      "extend:",
      "  permissions:",
      "    scope:",
      "      - in-scope.txt",
      "  output:",
      "    deliverable: role-report.md",
      "---",
      "",
      "You are role-deliverable: write the report and nothing else.",
      "",
    ],
    ["role-report.md", "other-report.md"],
  );
  const tail = tailOf(run);
  const childBodies = mock.requests.filter((body) =>
    systemText(body).includes("role-deliverable"));
  assert.ok(
    childBodies.length > 0,
    `the child session never issued an LLM request, so its prompt cannot be inspected. ${tail}`,
  );
  assert.ok(
    childBodies.some((body) => JSON.stringify(body).includes(
      `Deliverable: write it to \`role-report.md\`; the parent reads it at \`${join(project, "role-report.md")}\`.`)),
    `the child's prompt must carry the Confinement section's delivery line with both paths. ${tail}`,
  );
  assert.ok(
    childBodies.some((body) => JSON.stringify(body).includes("## Confinement")),
    `the child's prompt must carry the Confinement summary. ${tail}`,
  );
  const deliverable = files["role-report.md"];
  assert.ok(
    deliverable?.exists,
    `the deliverable must exist in the main project directory. ${tail}`,
  );
  assert.ok(
    deliverable?.content?.includes("DELIVERABLE-OK"),
    `the deliverable must hold the content the child wrote. ${HEAD(deliverable?.content ?? "")} ${tail}`,
  );
  assert.equal(
    files["other-report.md"]?.exists,
    false,
    `the grant is for one file, not its directory: a neighbouring write must not land. ${tail}`,
  );
  assert.ok(
    subagent.text.includes("other-report.md") &&
      subagent.text.includes("is outside the scope"),
    `the neighbouring write must be refused and the refusal must reach the parent. ${HEAD(subagent.text)} ${tail}`,
  );
  console.log("  ok   role md 交付物：提示词含短路径，主检出文件落盘，隔壁文件被拒");
}

// 3. extend.setup.preExec：只跑一次，且在子会话第一次工具调用之前。
{
  const { run, subagent, files } = await runCase(
    "role-preexec.yaml",
    "Go.",
    "role-preexec",
    [
      "---",
      "name: role-preexec",
      "description: Role md layer preExec probe",
      "inheritSkills: false",
      "inheritProjectContext: true",
      "tools: read, write",
      `subagentOnlyExtensions: "${EXT}"`,
      "extend:",
      "  permissions:",
      "    scope:",
      "      - preexec-marker.txt",
      "  setup:",
      '    preExec: "echo PREEXEC-RAN-ONCE >> preexec-marker.txt"',
      "---",
      "",
      "You are role-preexec: quote the marker verbatim.",
      "",
    ],
    ["preexec-marker.txt"],
  );
  const tail = tailOf(run);
  const marker = files["preexec-marker.txt"];
  assert.ok(
    marker?.exists,
    `setup.preExec must create its marker in the child cwd. ${tail}`,
  );
  assert.equal(
    marker?.content,
    "PREEXEC-RAN-ONCE\n",
    `the marker must hold exactly one line, proving preExec ran once. ${JSON.stringify(marker?.content)} ${tail}`,
  );
  assert.ok(
    subagent.text.includes("PREEXEC-RAN-ONCE"),
    `the marker's content must reach the parent from the child's first tool call, proving preExec ran before the child worked. ${HEAD(subagent.text)} ${tail}`,
  );
  console.log("  ok   role md preExec：标记在首次工具调用前落盘，且只跑一次");
}

// 4. 工作树里的子代理仍受主检出里的角色 md 约束：pwd 证明确实换了目录，
//    越界读被拒且点名 md，范围内读照常回流。
{
  const { run, subagent, project } = await runCase(
    "role-worktree.yaml",
    "Go.",
    "role-worktree",
    [
      "---",
      "name: role-worktree",
      "description: Role md from the main checkout in a worktree",
      "inheritSkills: false",
      "inheritProjectContext: true",
      "tools: read, write, bash",
      `subagentOnlyExtensions: "${EXT}"`,
      "extend:",
      "  permissions:",
      "    scope:",
      "      - in-scope.txt",
      "    bash:",
      "      allow:",
      "        - pwd",
      "---",
      "",
      "You are role-worktree: quote the three tool results verbatim.",
      "",
    ],
    [],
    { commit: true },
  );
  const tail = tailOf(run);
  assert.ok(
    subagent.text.includes("IN-SCOPE-OK"),
    `positive control: the worktree child must still be allowed to read in-scope.txt and carry its content back. ${HEAD(subagent.text)} ${tail}`,
  );
  assert.ok(
    subagent.text.includes("outside the read scope"),
    `the role md must still refuse the worktree child's out-of-scope read. ${HEAD(subagent.text)} ${tail}`,
  );
  assert.ok(
    subagent.text.includes("role md ") &&
      subagent.text.includes(join(".pi", "agents", "role-worktree.md")),
    `the refusal must name the role md file found through the main checkout. ${HEAD(subagent.text)} ${tail}`,
  );
  assert.equal(
    subagent.text.includes("OUT-OF-SCOPE-LEAK"),
    false,
    `a refused read must not leak the file's content. ${HEAD(subagent.text)} ${tail}`,
  );
  // 子会话的 pwd 输出由 {{toolResults}} 回流到 subagent 文本。工作树没建出来时这里必须
  // 显式失败：既不能只靠拒绝文案通过，也不能接受探针工程根目录当「工作树」。
  const pwdLines = subagent.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("pi-worktree-") && line.startsWith("/"));
  assert.ok(
    pwdLines.length > 0,
    `the child's pwd output must show a linked-worktree path; the worktree was not created. ${HEAD(subagent.text)} ${tail}`,
  );
  assert.ok(
    pwdLines.some((line) => line !== project && !line.startsWith(`${project}/`)),
    `the child must run in a worktree, not in the probe project root ${project}. pwd showed: ${pwdLines.join(" | ")} ${tail}`,
  );
  // 工作树副本里没有角色 md：否则这条用例在「向上找到子目录里的 md」的旧实现下也会过，
  // 就钉不住主检出锚点这条修复路径。
  assert.equal(
    existsSync(join(pwdLines[0], ".pi", "agents", "role-worktree.md")),
    false,
    `the worktree copy must not contain the role md; otherwise this case passes without the main-checkout lookup. ${tail}`,
  );
  console.log(`  ok   role md 工作树：子会话 cwd=${pwdLines[0]}，越界读被拒且点名主检出角色 md`);
}

// 5. 角色 md 的 `extend.worktree.enabled: true` 是派单参数的唯一来路：调用的参数里
//    从不出现 worktree，子会话仍然必须落在链接工作树里。缺这条通路时，md 里那三行
//    就只是一段没人读的配置 —— 也正是它让「md 写了不生效、显式传参才生效」成立。
{
  const { run, subagent, project } = await runCase(
    "role-worktree-default.yaml",
    "Go.",
    "role-worktree-default",
    [
      "---",
      "name: role-worktree-default",
      "description: Worktree default comes from the role md, not the call",
      "inheritSkills: false",
      "inheritProjectContext: true",
      "tools: read, write, bash",
      `subagentOnlyExtensions: "${EXT}"`,
      "extend:",
      "  worktree:",
      "    enabled: true",
      "  permissions:",
      "    scope:",
      "      - in-scope.txt",
      "    bash:",
      "      allow:",
      "        - pwd",
      "---",
      "",
      "You are role-worktree-default: quote the three tool results verbatim.",
      "",
    ],
    [],
    { commit: true },
  );
  const tail = tailOf(run);
  assert.ok(
    subagent.text.includes("IN-SCOPE-OK"),
    `positive control: the child must have run and read in-scope.txt through the role md. ${HEAD(subagent.text)} ${tail}`,
  );
  const pwdLines = subagent.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("pi-worktree-") && line.startsWith("/"));
  assert.ok(
    pwdLines.length > 0,
    `the role md's worktree default must put the child in a linked worktree, but pwd showed no worktree path: ${HEAD(subagent.text)} ${tail}`,
  );
  assert.ok(
    pwdLines.some((line) => line !== project && !line.startsWith(`${project}/`)),
    `the child must not run in the probe project root ${project}; pwd showed: ${pwdLines.join(" | ")} ${tail}`,
  );
  console.log(`  ok   role md 的工作树默认值：调用没提 worktree，子会话 cwd=${pwdLines[0]}`);
}

console.log("role md e2e tests passed (5 cases)");

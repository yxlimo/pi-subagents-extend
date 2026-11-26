// 绝对读授权（extend.permissions.scope 里的绝对路径条目）的契约用例。
//
// 对称于写侧的 absoluteWrite：相对条目仍绑在项目树上（matches 里「落在工作树之外一律
// 不认」是软链逃逸的唯一防线），绝对条目是父代理点名的树外读前缀，由 underAny 按真实
// 路径比对。两者并存取并集。
//
// 这些用例走真实调用链：handler 激活 → tool_call 判定 → 拒绝文案 / Confinement 段 /
// /permission。断言的是「子代理实际能不能读到、读到什么、被告知了什么」，不是某个内部
// 小函数的返回值。
//
// 一条用例一个具名任务：单条失败时后面的用例照跑，最后打印总数——一条用例挂了就把其余
// 十几条的结论吞掉，是最容易把「红」看成「绿」的形状。
//
//   node packages/pi-plugin/test/policy/absolute-read.test.ts
//
// 覆盖的任务契约：
//   1. 解析：绝对条目 → absoluteRead（canonical），相对条目仍进 globs；并集生效
//   2. 判定：读工具先相对匹配，失败再按 absoluteRead 前缀（真实路径）匹配；
//      树内软链指向未授权树外仍必须被拒
//   3. readOnly + absoluteRead：树外读成立，写仍全拒
//   4. bash 命令内路径：落在 absoluteRead 前缀内的不判越界，其余仍拒
//   5. 默认关闭：无绝对读条目时，判定与对外文案（Confinement 段、/permission）不变

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { childRun, handler, writeAgentMd } from "../harness.ts"
import type { PromptOptions } from "../types.ts"

const SCOPE_SECTION = "pi_subagents_extend_scope"
const sectionsOf = (options: PromptOptions): Record<string, string> =>
  (options.sections ?? {}) as unknown as Record<string, string>

// 一棵项目树（子代理的工作目录）+ 两片它不是成员的树外目录。
// handed-out/  父代理点名的树外证据目录（会作为绝对读授权）
// unrelated/   与 handed-out 平级的兄弟目录，没有任何授权提到它
//
// 两片目录必须物理分开：同一条绝对前缀同时覆盖「该读的」与「不该读的」时，用例什么也钉不住。
const root = mkdtempSync(join(tmpdir(), "pi-subagents-extend-absolute-read-"))
const proj = join(root, "proj")
const handedOut = join(root, "handed-out")
const unrelated = join(root, "unrelated")
const designDir = join(handedOut, "design")

mkdirSync(join(proj, "src"), { recursive: true })
mkdirSync(join(designDir, "nested"), { recursive: true })
mkdirSync(join(handedOut, "notes"), { recursive: true })
mkdirSync(unrelated, { recursive: true })

writeFileSync(join(proj, "src", "a.ts"), "a\n")
writeFileSync(join(designDir, "spec.md"), "spec\n")
writeFileSync(join(designDir, "nested", "deep.md"), "deep\n")
writeFileSync(join(handedOut, "notes", "other.md"), "other\n")
writeFileSync(join(unrelated, "elsewhere.md"), "elsewhere\n")

// 树内软链：一条指向未授权的树外文件，一条指向授权前缀内的树外文件。
// 相对路径写法（src/link-*.md）是子代理最容易构造的逃逸形状。
symlinkSync(join(unrelated, "elsewhere.md"), join(proj, "src", "link-unauthorized.md"))
symlinkSync(join(designDir, "spec.md"), join(proj, "src", "link-authorized.md"))

const bindingsFor = (permissions: Record<string, unknown>): string =>
  JSON.stringify({ "pi-subagents-extend/1": permissions })

/** 只有一条绝对读授权的会话，最短路径地把授权摆上桌。 */
const withReadGrant = (extra: Record<string, unknown> = {}) =>
  handler({
    cwd: proj,
    bindings: bindingsFor({ scope: ["src/**", designDir], bash: false, maxDenies: 0, ...extra }),
  })

const cases: { name: string; run: () => Promise<void> }[] = []
const test = (name: string, run: () => Promise<void>): void => {
  cases.push({ name, run })
}

// AR1. 并集生效：绝对条目变成树外读授权，相对条目照旧授权项目树。
//      四条必须同时成立——树外允许、嵌套允许、前缀外的兄弟目录仍拒、无关的树外目录仍拒。
//      只断言前两条的话，一个「绝对条目把 globs 一并放开」的实现照样绿。
test("并集：绝对条目授权树外，相对条目照旧授权树，前缀外仍拒", async () => {
  const h = await withReadGrant()
  try {
    assert.equal(await h.call("read", { path: "src/a.ts" }), undefined, "a relative entry still authorises the project tree")
    assert.equal(
      await h.call("read", { path: join(designDir, "spec.md") }),
      undefined,
      "the absolute entry authorises a file in that outside tree",
    )
    assert.equal(
      await h.call("read", { path: join(designDir, "nested", "deep.md") }),
      undefined,
      "the grant is a prefix: a nested file is covered too",
    )
    const sibling = await h.call("read", { path: join(handedOut, "notes", "other.md") })
    assert.equal(sibling?.block, true, "a sibling of the granted directory is not covered")
    assert.match(String(sibling?.reason), /outside the read scope/, "and it is refused by the read scope")
    const foreign = await h.call("read", { path: join(unrelated, "elsewhere.md") })
    assert.equal(foreign?.block, true, "an unrelated outside tree stays refused")
    assert.match(String(foreign?.reason), /outside the read scope/, "refused by the read scope")
  } finally {
    h.restore()
  }
})

// AR2. 解析时必须归一化（canonical）：父代理把授权写成「目录/../目录/」这种非规范形状，
//      仍然要命中同一个真实目录。按原始字符串做前缀比对时这条会红。
test("绝对授权先 canonical 再按前缀比对", async () => {
  const sloppy = `${join(handedOut, "design", "..", "design")}/`
  const h = await handler({
    cwd: proj,
    bindings: bindingsFor({ scope: ["src/**", sloppy], bash: false, maxDenies: 0 }),
  })
  try {
    assert.equal(
      await h.call("read", { path: join(designDir, "spec.md") }),
      undefined,
      "the grant is canonicalised before it is compared",
    )
    const outside = await h.call("read", { path: join(unrelated, "elsewhere.md") })
    assert.equal(outside?.block, true, "canonicalising the grant does not widen it")
  } finally {
    h.restore()
  }
})

// AR3. 只写绝对条目时，读面只剩树外：绝对条目不能落回 globs。
//      落回去的话，compile 会把它当相对 glob 编译——树内文件因此被「顺带」授权，
//      而一个写成 `/x/**` 的条目永远匹配不到任何东西（相对路径里没有前导斜杠）。
test("只配绝对条目时读面只有树外，树内读不到", async () => {
  const h = await handler({
    cwd: proj,
    bindings: bindingsFor({ scope: [designDir], bash: false, maxDenies: 0 }),
  })
  try {
    assert.equal(
      await h.call("read", { path: join(designDir, "spec.md") }),
      undefined,
      "the only entry is absolute and it authorises that tree",
    )
    const inTree = await h.call("read", { path: "src/a.ts" })
    assert.equal(inTree?.block, true, "no relative entry means no project-tree read")
    assert.match(String(inTree?.reason), /outside the read scope/, "the in-tree file is outside this scope")
  } finally {
    h.restore()
  }
})

// AR4. 逃逸防线：树内软链指向**未授权**的树外文件，必须照旧被拒。
//      判定按真实路径做前缀比对，软链的真实路径不落在授权前缀内。
test("树内软链指向未授权树外仍被拒", async () => {
  const h = await withReadGrant()
  try {
    const viaLink = await h.call("read", { path: "src/link-unauthorized.md" })
    assert.equal(viaLink?.block, true, "a symlink inside the tree cannot smuggle an unauthorised file in")
    assert.match(String(viaLink?.reason), /outside the read scope/, "refused by the read scope, not by a link rule")
  } finally {
    h.restore()
  }
})

// AR5. 同一套软链机制，目标落在授权前缀内时应当成立：判的是真实路径。
//      与 AR4 合起来把「按真实路径比前缀」钉死：只按字面路径比时 AR5 红，
//      只按字面路径放行时 AR4 红。
test("软链真实路径落在授权前缀内时可读", async () => {
  const h = await withReadGrant()
  try {
    assert.equal(await h.call("read", { path: "src/link-authorized.md" }), undefined, "a symlink whose real target is under the grant is readable")
  } finally {
    h.restore()
  }
})

// AR6. `..` 相对写法不能绕过授权边界：从树内用 `..` 走到授权前缀之外的兄弟目录仍被拒。
test("`..` 写法的未授权目标仍被拒", async () => {
  const h = await withReadGrant()
  try {
    const up = await h.call("read", { path: "../unrelated/elsewhere.md" })
    assert.equal(up?.block, true, "`..` is not a way into an unauthorised tree")
    assert.match(String(up?.reason), /outside the read scope/, "refused by the read scope")
  } finally {
    h.restore()
  }
})

// AR7. readOnly + 绝对读授权：树外读成立，写仍然全拒——包括写进那条读授权前缀里。
//      「读得到」不能顺手把「写得进去」也放开，这是这单最容易失手的对称面。
test("readOnly + 绝对读授权：树外可读，写（含该前缀内）全拒", async () => {
  const h = await withReadGrant({ readOnly: true, maxWriteDenies: 0 })
  try {
    assert.equal(await h.call("read", { path: join(designDir, "spec.md") }), undefined, "read-only still reads the granted outside file")
    assert.equal(await h.call("read", { path: "src/a.ts" }), undefined, "and still reads the project tree")
    const outsideWrite = await h.call("write", { path: join(designDir, "report.md"), content: "x" })
    assert.equal(outsideWrite?.block, true, "a read grant is not a write grant")
    assert.match(String(outsideWrite?.reason), /no write grant/, "the refusal names the missing write grant")
    const insideWrite = await h.call("write", { path: "src/a.ts", content: "x" })
    assert.equal(insideWrite?.block, true, "read-only refuses writes inside the tree too")
  } finally {
    h.restore()
  }
})

// AR8. bash 命令内的路径：落在绝对读授权前缀内的参数不再判越界；
//      其余树外路径照旧按「不是你的工作树」拒掉，并点名那个参数。
test("bash 参数：授权前缀内放行，其余树外路径仍拒", async () => {
  const h = await handler({
    cwd: proj,
    bindings: bindingsFor({ scope: ["src/**", designDir], bash: { allow: ["rg"] }, maxDenies: 0 }),
  })
  try {
    assert.equal(
      await h.call("bash", { command: `rg spec ${join(designDir, "spec.md")}` }),
      undefined,
      "a read-class command may name a file under the absolute read grant",
    )
    const foreign = await h.call("bash", { command: `rg spec ${join(unrelated, "elsewhere.md")}` })
    assert.equal(foreign?.block, true, "a path outside every grant is still refused")
    assert.ok(
      String(foreign?.reason).includes("is outside the working tree"),
      `the refusal still names the working tree, got: ${foreign?.reason}`,
    )
    assert.ok(
      String(foreign?.reason).includes(join(unrelated, "elsewhere.md")),
      `the refusal still names the offending argument, got: ${foreign?.reason}`,
    )
  } finally {
    h.restore()
  }
})

// AR9. 默认关闭（对外文案）：没有任何绝对读条目时，Confinement 段里不能出现绝对授权。
//      Read 行逐字比较，不用正则——这一行是子代理判断「我能读哪」的主要依据。
test("无绝对条目时 Confinement 段的 Read 行逐字不变", async () => {
  const home = join(root, "home-off")
  mkdirSync(home, { recursive: true })
  const md = writeAgentMd({
    cwd: proj,
    role: "absolute-read-off",
    extend: { permissions: { scope: ["src/**"] } },
  })
  const options: PromptOptions = {}
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="absolute-read-off"/>\nhello',
    systemPromptOptions: options,
  })
  try {
    const text = sectionsOf(options)[SCOPE_SECTION] ?? ""
    assert.ok(text.length > 0, `the child receives the Confinement section, got: ${JSON.stringify(options.sections)}`)
    const readLines = text.split("\n").filter((line) => line.startsWith("- Read"))
    assert.deepEqual(readLines, ["- Read: src/**"], "the read line is byte-identical to today")
    assert.ok(!text.includes(handedOut), "no outside read grant leaks into the section")
    assert.ok(text.includes(md), `the section still names its md source, got:\n${text}`)
  } finally {
    run.restore()
  }
})

// AR10. 默认关闭（判定）：没有绝对读条目时，树外读照旧被拒，文案里的 Read scope 只列 globs。
//       与 AR1 是同一件事的两面：授权没配就不该有任何一棵树外路径变得可读。
test("无绝对条目时树外读仍被拒，拒绝文案只列相对范围", async () => {
  const h = await handler({
    cwd: proj,
    bindings: bindingsFor({ scope: ["src/**"], bash: false, maxDenies: 0 }),
  })
  try {
    const outside = await h.call("read", { path: join(designDir, "spec.md") })
    assert.equal(outside?.block, true, "with no absolute entry, that file is still outside the read scope")
    assert.match(String(outside?.reason), /outside the read scope/, "refused by the read scope")
    // 拒绝文案里的 Read scope 行只列相对范围：文案本身会引用被拒的目标路径（那是必要的），
    // 所以要看的是「范围」那一行，而不是整段里有没有出现该路径。
    const scopeLines = String(outside?.reason)
      .split("\n")
      .filter((line) => line.startsWith("Read scope: "))
    assert.deepEqual(scopeLines, ["Read scope: src/**"], "the refusal lists only the relative read scope")
  } finally {
    h.restore()
  }
})

// AR11. 对外可见性（Confinement 段）：配了绝对读授权时，子代理必须能从段里读到它。
//       子代理不知道这条授权，就会以为树外证据读不到、然后换别的写法硬试——这段文案存在
//       的理由就是这个。除了这一条授权，其余行必须与关闭态逐字节相同。
test("配了绝对读授权时子代理能在 Confinement 段里看到它，其余行不变", async () => {
  const home = join(root, "home-on")
  mkdirSync(home, { recursive: true })
  writeAgentMd({
    cwd: proj,
    role: "absolute-read-on",
    // 写范围显式给死树内：不写的话写范围默认等于读范围，那条绝对条目会顺带出现在 Write
    // 行里，这一段就分不清「多出来的是读授权还是写授权」。
    extend: { permissions: { scope: ["src/**", designDir], write: ["src/**"] } },
  })
  const options: PromptOptions = {}
  const run = await childRun({
    cwd: proj,
    home,
    systemPrompt: '<active_agent name="absolute-read-on"/>\nhello',
    systemPromptOptions: options,
  })
  try {
    const text = sectionsOf(options)[SCOPE_SECTION] ?? ""
    const grantLines = text.split("\n").filter((line) => line.includes(designDir))
    assert.equal(grantLines.length, 1, `the child is told about the granted tree exactly once, got:\n${text}`)
    assert.match(grantLines[0], /^-\s+Absolute read: /, `the line names what the grant is, got: ${grantLines[0]}`)

    // 同一份配置去掉那条绝对条目：除了「多了这条授权」，其余每个字节都必须一样。
    const offHome = join(root, "home-on-control")
    mkdirSync(offHome, { recursive: true })
    writeAgentMd({
      cwd: proj,
      role: "absolute-read-on-control",
      extend: { permissions: { scope: ["src/**"], write: ["src/**"] } },
    })
    const controlOptions: PromptOptions = {}
    const control = await childRun({
      cwd: proj,
      home: offHome,
      systemPrompt: '<active_agent name="absolute-read-on-control"/>\nhello',
      systemPromptOptions: controlOptions,
    })
    try {
      const controlText = sectionsOf(controlOptions)[SCOPE_SECTION] ?? ""
      const withoutGrant = text
        .split("\n")
        .filter((line) => !line.includes(designDir))
        .join("\n")
        .split("absolute-read-on")
        .join("absolute-read-on-control")
      assert.equal(withoutGrant, controlText, "the grant adds its own line and changes nothing else in the section")
    } finally {
      control.restore()
    }
  } finally {
    run.restore()
  }
})

// AR12. 对外可见性（/permission）：会话里跑 /permission，必须把这条绝对授权报出来，
//       否则父代理查「到底授予了什么」时会看不到它——那正是 /permission 的用途。
test("/permission 报出绝对读授权", async () => {
  const h = await withReadGrant()
  try {
    const notified: string[] = []
    await h.commands["permission"].handler("", { cwd: proj, ui: { notify: (message: string) => notified.push(message) } })
    const report = notified.join("\n")
    // 报出这条授权的必须是「读」那一栏：只出现在 Write scope 里，父代理会以为自���授的是写权限。
    const grantLines = report.split("\n").filter((line) => /^(Read scope|Absolute read): /.test(line) && line.includes(designDir))
    assert.equal(grantLines.length, 1, `/permission reports the grant once in the read column, got:\n${report}`)
    assert.match(grantLines[0], /^Absolute read: /, `/permission names what the grant is, got: ${grantLines[0]}`)
  } finally {
    h.restore()
  }
})

// AR13. /permission 的关闭态：没有绝对条目时，Read scope 这一行逐字等于今天的样子。
test("无绝对条目时 /permission 的 Read scope 逐字不变", async () => {
  const h = await handler({
    cwd: proj,
    bindings: bindingsFor({ scope: ["src/**"], bash: false, maxDenies: 0 }),
  })
  try {
    const notified: string[] = []
    await h.commands["permission"].handler("", { cwd: proj, ui: { notify: (message: string) => notified.push(message) } })
    const report = notified.join("\n")
    const readScopes = report.split("\n").filter((line) => line.startsWith("Read scope: "))
    assert.deepEqual(readScopes, ["Read scope: src/**"], "the read-scope line is byte-identical to today")
    assert.ok(!report.includes(handedOut), "no outside read grant leaks into /permission")
  } finally {
    h.restore()
  }
})

console.log("pi-subagents-extend absolute read grants")
const failures: string[] = []
for (const item of cases) {
  try {
    await item.run()
    console.log(`  ok   ${item.name}`)
  } catch (error) {
    failures.push(item.name)
    console.error(`  FAIL ${item.name}\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  }
}
rmSync(root, { recursive: true, force: true })
assert.deepEqual(failures, [], `${failures.length} of ${cases.length} absolute-read cases failed: ${failures.join("; ")}`)
console.log(`\nabsolute read tests passed (${cases.length} cases)`)

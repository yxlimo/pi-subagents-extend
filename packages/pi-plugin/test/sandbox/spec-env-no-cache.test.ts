// MISE_STATE_DIR 的兜底分支：有写授权但工具链缓存建不出来时，state 退回沙箱私有 /tmp。
//
// sandboxEnv 的落点规则是「有写授权 → 落 toolchainCacheDir()/mise-state；否则 → 私有 /tmp」。
// 只读任务那一格已有 174 钉住，「有写授权但缓存建不出来」这一格此前没有任何正向用例：验证单
// 实测，把 toolchainCacheDir() 的 catch 体改成错误值，全套件依旧全绿。
//
// 本文件在独立进程里（test:sandbox 每个文件一次 node 运行）把 toolchainCacheDir() 弄成
// 不可用，走确定性构造而不是 chmod：cache 在 ~/.cache/pi-subagents-extend/xdg-cache，工作树
// 之外，沙箱里的 Landlock 会拒 chmodSync。改用 stateDir() 认的 PI_SUBAGENTS_EXTEND_STATE：
// 把它指向一个父路径是普通文件的位置（mkdtemp 下建一个名叫 notadir 的文件，state 设成
// <tmp>/notadir/sub）→ toolchainCacheDir() 里的 mkdirSync(recursive) 抛 ENOTDIR → cache
// 为 undefined。
//
// memo 注意：toolchainCacheDirMemo 是进程级记忆，本文件在第一次 buildSpec 之前就把环境变量
// 设好（先设后调，就一个用例，天然满足）。
//
// 钉的是「工具链缓存建不出来（toolchainCacheDir() 返回 undefined）→ MISE_STATE_DIR 退回
// 沙箱私有 /tmp」这一支。不钉 sandboxEnv 里 mkdirSync(<cache>/mise-state) 抛错那一支 ——
// 那一支需要 mock 文件系统，本单不做。

import assert from "node:assert/strict"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { toolchainCacheDir } from "../../src/sandbox/grants.ts"
import { buildSpec } from "../../src/sandbox/spec.ts"
import { stateDir } from "../state-dir.ts"

// 夹具根：与 harness 同一套约定 —— 沙箱里落在工作树根的 .test-state（角色授权覆盖它），
// 本地则回退到包目录下被 gitignore 的 .test-*。
const root = stateDir(".spec-env-no-cache-")

// 父路径是普通文件：toolchainCacheDir() 的 mkdirSync(recursive) 抛 ENOTDIR → cache undefined。
writeFileSync(join(root, "notadir"), "")
process.env.PI_SUBAGENTS_EXTEND_STATE = join(root, "notadir", "sub")

const restore = (): void => {
  rmSync(root, { recursive: true, force: true })
}
process.on("exit", restore)
// 收到信号时 exit 钩子不跑：Ctrl-C 留下的临时目录会被补丁采集误收进去。
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    restore()
    process.exit(130)
  })
}

// 177. 工具链缓存建不出来 → MISE_STATE_DIR 退回沙箱私有 /tmp。
{
  // 前置自检：夹具确实把 cache 打成不可用了。这一步同时是本进程对 toolchainCacheDir() 的
  // 第一次调用，memo 从这里起就是 undefined。
  assert.equal(toolchainCacheDir(), undefined, "the PI_SUBAGENTS_EXTEND_STATE fixture makes the toolchain cache unresolvable")

  const cwd = join(root, "cwd")
  mkdirSync(cwd, { recursive: true })
  const rule = ({ scratchPaths: [], writablePaths: [], env: {}, gitExcludes: false }) as never
  const spec = buildSpec(cwd, rule, { writeGlobs: ["granted"] } as never)
  const expected = `/tmp/.pi-subagents-extend-${process.pid}/mise`
  assert.equal(spec.env.MISE_STATE_DIR, expected, `a write grant with no usable toolchain cache falls back to the private tmp, got: ${spec.env.MISE_STATE_DIR}`)
  console.log("  ok   工具链缓存建不出来 → MISE_STATE_DIR 退回沙箱私有 /tmp")
}

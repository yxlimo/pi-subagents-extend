import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handler, specOf, workdir } from "../harness.ts"

// 58. A temporary directory outside /tmp has to be privatized, not just granted. The
// extension used to grant os.tmpdir() while the helper only ever mounted a tmpfs on the
// hard-coded /tmp, so a host with TMPDIR set elsewhere got a directory that was writable
// through Landlock with no mount over it: temp files landed on the host, outside the
// sandbox. The spec now names that directory, and the helper mounts on what it names.
{
  const previousTmpdir = process.env.TMPDIR
  const scratch = join(workdir, "scratch-outside-tmp")
  mkdirSync(scratch, { recursive: true })
  process.env.TMPDIR = scratch
  const h = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: { allow: ["pnpm run typecheck"], writable: true } } }),
  })
  const input = { command: "pnpm run typecheck" }
  assert.equal(await h.call("bash", input), undefined, "a listed command still passes with a custom TMPDIR")
  const spec = specOf(input.command)
  assert.equal(
    spec.tmp,
    scratch,
    "the spec names the directory the command's temp files land in, so the helper puts its tmpfs there",
  )
  assert.ok(spec.write.includes(scratch), "that directory is writable, which is only safe together with the mount above")
  assert.ok(spec.write.includes("/tmp"), "the conventional /tmp stays writable: XDG_RUNTIME_DIR and MISE_STATE_DIR point into it")
  h.restore()
  if (previousTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = previousTmpdir

  // 没有自定义 TMPDIR 时字段省略：/tmp 本来就是 helper 的默认值，而不带这个字段的 spec
  // 仍能被旧版 helper 解开（它的 spec 解析是 deny_unknown_fields）。
  delete process.env.TMPDIR
  const plain = await handler({
    bindings: JSON.stringify({ "pi-subagents-extend/1": { scope: ["src/**"], bash: { allow: ["pnpm run typecheck"], writable: true } } }),
  })
  const plainInput = { command: "pnpm run typecheck" }
  assert.equal(await plain.call("bash", plainInput), undefined, "listed command passes")
  assert.equal(
    specOf(plainInput.command).tmp,
    tmpdir() === "/tmp" ? undefined : tmpdir(),
    "only a scratch dir that differs from the helper's default is spelled out",
  )
  plain.restore()
  if (previousTmpdir !== undefined) process.env.TMPDIR = previousTmpdir
  console.log("  ok   TMPDIR 不在 /tmp 下时，那个目录也写进 spec 并被私有化；默认值时不写")
}








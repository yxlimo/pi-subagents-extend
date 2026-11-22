// 策略模块的细粒度单测：直接调用纯函数，不经过 handler、不建假 pi API、不读 bindings JSON。
//
// test/policy.test.ts 看起来在测这一层，但它的调用点都走 h.call，从不直接调用
// parsePolicyObject / globToRegExp —— 模块故障与接线故障在那里分不开。
// src/policy/ 拆成 payload / glob 两个模块，这里给它们各自的直接测试。
//
//   node test/unit/policy.unit.test.ts

import assert from "node:assert/strict";
import {
	extractCallConfig,
	globToRegExp,
	parsePolicyObject,
} from "../../src/policy/index.ts";

let passed = 0;
function ok(label: string): void {
  passed += 1;
  console.log(`  ok   ${label}`);
}

// bindingKey() = "pi-subagents-extend/1"（见 src/role-config.ts）。
const NS = "pi-subagents-extend/1";
/** namespace 层直接放 body（用来造「缺 permissions」的扁平载荷）。 */
const ns = (body: unknown): string => JSON.stringify({ [NS]: body });
/** namespace 层包一层 permissions（派单载荷的正确形状）。 */
const perms = (permissions: unknown): string => ns({ permissions });


// ---- extractCallConfig / parsePolicyObject（src/policy/payload.ts）----

// permissions 包装是必需的：扁平载荷整份拒绝，不落到任何策略字段。
{
	const res = extractCallConfig(ns({ scope: ["src/**"] }));
	assert.ok(res.error);
	assert.match(res.error, /missing "permissions" object/);
	assert.match(res.error, /everything is refused/);
	assert.equal(res.config, undefined);
	ok("extractCallConfig: 缺 permissions 包装的扁平载荷整份拒绝");
}

// 派单载荷里出现未知键整份拒绝，且文案点名正确拼法（write → writeScope）。
{
	const res = extractCallConfig(perms({ write: ["x"] }));
	assert.ok(res.error);
	assert.match(res.error, /"write" \(the dispatch spelling is "writeScope"\)/);
	assert.match(res.error, /everything is refused/);
	assert.equal(res.config, undefined);
	ok("extractCallConfig: 未知键整份拒绝并提示 write → writeScope");
}

// __proto__ 是普通键：既不污染原型链，也不进 config、不报错。
{
	// 手写 JSON：对象字面量里的 __proto__ 是 setter，不会成为自有键，必须绕开字面量。
	const payload =
		'{"pi-subagents-extend/1":{"permissions":{"__proto__":{"isPolluted":true},"scope":["src/**"]}}}';
	const res = extractCallConfig(payload);
	assert.equal(res.error, undefined);
	assert.equal((Object.prototype as { isPolluted?: unknown }).isPolluted, undefined);
	assert.equal(Object.prototype.hasOwnProperty.call(res.config, "__proto__"), false);
	assert.deepEqual(res.config?.scope, ["src/**"]);
	ok("extractCallConfig: __proto__ 惰性，不污染原型链");
}

// setup / output 是给别的扩展的：只报告，不进策略。
{
	const res = extractCallConfig(
		perms({ scope: ["src/**"], setup: { preExec: "x" }, output: { deliverable: "y" } }),
	);
	assert.equal(res.error, undefined);
	assert.deepEqual(res.ignored, ["setup", "output"]);
	assert.deepEqual(res.config?.scope, ["src/**"]);
	assert.equal(Object.prototype.hasOwnProperty.call(res.config, "setup"), false);
	assert.equal(Object.prototype.hasOwnProperty.call(res.config, "output"), false);
	ok("extractCallConfig: setup / output 只报告不应用");
}

// parsePolicyObject：requireScope 区分派单（必须有 scope）与 profile 默认值（可无 scope）。
{
	const required = parsePolicyObject({}, "src", { requireScope: true });
	assert.equal(required.active, true);
	assert.deepEqual(required.globs, []);
	assert.match(required.source, /scope is missing/);
	const optional = parsePolicyObject({}, "src", { requireScope: false });
	assert.deepEqual(optional.globs, []);
	assert.equal(optional.source, "src");
	ok("parsePolicyObject: requireScope 区分派单与 profile 默认值");
}


// ---- globToRegExp（src/policy/glob.ts）----

// `**` 跨目录：`**/` 吃掉零段或多段目录，裸 `**` 吃掉任意层。
{
	const nested = globToRegExp("**/foo.ts");
	assert.equal(nested.test("foo.ts"), true);
	assert.equal(nested.test("a/b/foo.ts"), true);
	const any = globToRegExp("**");
	assert.equal(any.test("a/b/c"), true);
	ok("globToRegExp: ** 跨目录");
}

// `*` 不跨目录：只匹配单段内的任意字符。
{
	const re = globToRegExp("src/*.ts");
	assert.equal(re.test("src/a.ts"), true);
	assert.equal(re.test("src/sub/a.ts"), false);
	ok("globToRegExp: * 不跨目录");
}

// `?` 恰好一个字符，且不匹配分隔符。
{
	const re = globToRegExp("a?c");
	assert.equal(re.test("abc"), true);
	assert.equal(re.test("a"), false);
	assert.equal(re.test("abcd"), false);
	assert.equal(re.test("a/c"), false);
	ok("globToRegExp: ? 匹配一个字符");
}

// 字面量 `.` 不匹配任意字符（只匹配点本身）。
{
	const re = globToRegExp("a.ts");
	assert.equal(re.test("a.ts"), true);
	assert.equal(re.test("axts"), false);
	ok("globToRegExp: 字面量 . 不匹配任意字符");
}

console.log(`\npi-subagents-extend policy unit tests passed (${passed} cases)`);

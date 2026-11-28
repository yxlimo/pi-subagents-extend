// 进程级会话归属：同一会话里只让一份扩展副本干活。
//
// 这里的每个块都钉一个独立的契约点：返回 undefined（而不是抛错）、node_modules 让位、
// 跨会话互不干扰、单副本回归、无身份照常执行、同路径两次激活、release 的 owner/token
// 判据，以及 activate() 装配后真实 pi.on handler 的整-session 惰性。
//
// 用例自己造 owner 路径（真实加载第二份副本做不到），但装配级用例走真实 activate()。
//
//   node test/wiring/session-owner.test.ts

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createOwnership,
	createOwnHandler,
	ownerTable,
	OWNER,
} from "../../src/session-owner.ts";
import { activate } from "../../src/index.ts";
import type { EventHandler, FakeExtensionApi } from "../types.ts";

interface Notice {
	message: string;
	level?: string;
}

interface SessionState {
	claims: Map<string, string>;
	reported: Map<string, Set<string>>;
}

const STATE = Symbol.for("pi-subagents-extend.session-state");

/** 归属表是进程级的；每个块从空表开始，免得用例互相借归属。 */
function resetOwnership(): void {
	ownerTable().clear();
	const state = (globalThis as unknown as Record<symbol, SessionState | undefined>)[STATE];
	state?.claims.clear();
	state?.reported.clear();
}

/** 事件 ctx 只给归属判定需要的 sessionManager 与告警通道。 */
function ctxOf(sessionId: string | undefined, notices: Notice[] = []): ExtensionContext {
	const ctx: Record<string, unknown> = {
		cwd: "/repo",
		ui: {
			notify(message: string, level?: string) {
				notices.push({ message, level });
			},
		},
	};
	if (sessionId !== undefined) ctx.sessionManager = { getSessionId: () => sessionId };
	return ctx as unknown as ExtensionContext;
}

let passed = 0;
function ok(label: string): void {
	passed += 1;
	console.log(`  ok   ${label}`);
}

// 1. 两份不同路径副本 + 同一 sessionId：只有先抢占的那份执行，另一份返回 undefined。
{
	resetOwnership();
	const noticesA: Notice[] = [];
	const noticesB: Notice[] = [];
	const a = createOwnership({ owner: "/proj/.pi/extensions/x/src/index.ts" });
	const b = createOwnership({ owner: "/other/copy/x/src/index.ts" });
	const ha = createOwnHandler(a);
	const hb = createOwnHandler(b);
	const ca = ctxOf("two-paths", noticesA);
	const cb = ctxOf("two-paths", noticesB);
	let ranA = 0;
	let ranB = 0;

	assert.equal(await ha(ca, () => { ranA += 1; return "a"; }), "a", "the first copy runs normally");
	assert.equal(await hb(cb, () => { ranB += 1; return "b"; }), undefined, "the other copy hands the whole session over");
	assert.equal(ranA, 1, "the winner's body ran once");
	assert.equal(ranB, 0, "the loser's body never ran");
	assert.equal(ownerTable().get("two-paths"), a.owner, "the table names the winning path");

	// 惰性是整个会话的，不是一次性的：后续事件也不能让第二份判第二遍。
	assert.equal(await ha(ca, () => "still-a"), "still-a");
	assert.equal(await hb(cb, () => "still-b"), undefined, "the loser stays inert on later events");
	assert.equal(noticesA.length, 0, "the winner is silent");
	assert.equal(noticesB.length, 1, "the loser reports the collision once");
	ok("两份不同路径副本同会话：一份执行，另一份返回 undefined 且后续仍惰性");
}

// 2. 安装版先抢、项目级后到：项目级改抢，安装版从此惰性；冲突告警只报一次且点名两份路径。
{
	resetOwnership();
	const installedNotices: Notice[] = [];
	const projectNotices: Notice[] = [];
	const installed = createOwnership({ owner: "/home/u/.pi/agent/npm/node_modules/x/src/index.ts" });
	const project = createOwnership({ owner: "/proj/.pi/extensions/x/src/index.ts" });
	const hi = createOwnHandler(installed);
	const hp = createOwnHandler(project);
	const ci = ctxOf("priority", installedNotices);
	const cp = ctxOf("priority", projectNotices);

	assert.equal(await hi(ci, () => "installed"), "installed", "the installed copy wins when it arrives first");
	assert.equal(await hp(cp, () => "project"), "project", "the project-local copy takes over");
	assert.equal(ownerTable().get("priority"), project.owner, "the table now names the project-local path");

	assert.equal(projectNotices.length, 1, "takeover reports exactly one conflict");
	assert.equal(projectNotices[0].level, "warning", "the conflict goes to the warning channel");
	assert.match(projectNotices[0].message, /node_modules/, "the warning names the installed path");
	assert.match(projectNotices[0].message, /\/proj\/\.pi\/extensions/, "the warning names the project-local path");

	assert.equal(await hi(ci, () => "installed-again"), undefined, "the installed copy is inert after takeover");
	assert.equal(await hp(cp, () => "project-again"), "project-again", "the project-local copy keeps running");
	assert.equal(projectNotices.length, 1, "no second warning from the active copy");
	assert.equal(installedNotices.length, 0, "no second warning from the demoted copy");
	ok("安装版让位给项目级：改抢成功、旧主人惰性、告警一次且含两份路径");
}

// 3. 父子会话（同进程、不同 sessionId）：两份都执行，互不干扰。
{
	resetOwnership();
	const a = createOwnership({ owner: "/proj/parent-copy" });
	const b = createOwnership({ owner: "/proj/child-copy" });
	const ha = createOwnHandler(a);
	const hb = createOwnHandler(b);
	const parent = ctxOf("parent-session");
	const child = ctxOf("child-session");

	assert.equal(await ha(parent, () => "p"), "p", "parent session runs in copy a");
	assert.equal(await hb(child, () => "c"), "c", "child session runs in copy b");
	assert.equal(ownerTable().get("parent-session"), a.owner, "parent session belongs to a");
	assert.equal(ownerTable().get("child-session"), b.owner, "child session belongs to b");
	assert.equal(await ha(parent, () => "p2"), "p2", "parent keeps its owner");
	assert.equal(await hb(child, () => "c2"), "c2", "child keeps its owner");
	ok("父子会话不同 sessionId：两份各自执行，表项互不顶掉");
}

// 4. 单副本单会话回归：handler 照常执行并透传返回值；顺带钉住默认 owner = 模块 realpath。
{
	resetOwnership();
	const own = createOwnership();
	assert.equal(own.owner, OWNER, "the default owner is the module path");
	assert.equal(existsSync(OWNER), true, "OWNER is a real path on disk");
	assert.match(OWNER, /session-owner\.ts$/, "OWNER points at this module");

	const notices: Notice[] = [];
	const h = createOwnHandler(own);
	const ctx = ctxOf("single-copy", notices);
	let ran = 0;
	assert.equal(await h(ctx, async () => { ran += 1; return 7; }), 7, "an async body's result is propagated");
	assert.equal(await h(ctx, () => { ran += 1; return "again"; }), "again");
	assert.equal(ran, 2, "the body ran for every event");
	assert.equal(notices.length, 0, "one copy produces no conflict warning");
	assert.equal(ownerTable().get("single-copy"), OWNER, "the session belongs to the module path");
	ok("单副本单会话：返回值与副作用与改造前一致，默认 owner 是模块 realpath");
}

// 5. 没有身份（无 ctx / 无 sessionManager / 空串）：不参与归属判定，照常执行且不写表。
{
	resetOwnership();
	const variants: Array<{ name: string; ctx: unknown }> = [
		{ name: "no ctx", ctx: undefined },
		{ name: "no sessionManager", ctx: { cwd: "/repo", ui: { notify() {} } } },
		{ name: "empty session id", ctx: ctxOf("") },
	];
	for (const [index, variant] of variants.entries()) {
		const h = createOwnHandler(createOwnership({ owner: `/proj/no-id-${index}` }));
		let ran = 0;
		assert.equal(
			await h(variant.ctx as ExtensionContext, () => { ran += 1; return 42; }),
			42,
			`${variant.name}: the body runs`,
		);
		assert.equal(ran, 1, `${variant.name}: ran exactly once`);
	}
	assert.equal(ownerTable().size, 0, "identity-less events never touch the process table");
	ok("无 ctx / 无 sessionManager / 空串 id：照常执行且不写归属表");
}

// 6. 同一 realpath 两次 createOwnership：先到先得，第二份整会话惰性。
{
	resetOwnership();
	const firstNotices: Notice[] = [];
	const secondNotices: Notice[] = [];
	const first = createOwnership({ owner: "/proj/same-file.ts" });
	const second = createOwnership({ owner: "/proj/same-file.ts" });
	const h1 = createOwnHandler(first);
	const h2 = createOwnHandler(second);
	const c1 = ctxOf("same-file", firstNotices);
	const c2 = ctxOf("same-file", secondNotices);

	assert.equal(await h1(c1, () => "first"), "first", "the first activation owns the session");
	assert.equal(await h2(c2, () => "second"), undefined, "the second activation is inert");
	assert.equal(await h1(c1, () => "still-first"), "still-first", "the first activation keeps running");
	assert.equal(secondNotices.length, 1, "the collision is reported once");
	assert.match(secondNotices[0].message, /loaded twice/, "the warning says the same file was loaded twice");
	assert.match(secondNotices[0].message, /\/proj\/same-file\.ts/, "the warning names the shared path");
	assert.equal(firstNotices.length, 0, "the first activation stays silent");
	ok("同 realpath 两次激活：先到先得，后一份惰性且点名 same file");
}

// 7. release：只有当前 owner 且 token 匹配才删表项；交还后新激活可重新抢占。
{
	resetOwnership();
	const a = createOwnership({ owner: "/proj/owner-a" });
	const b = createOwnership({ owner: "/proj/owner-b" });
	const ctx = ctxOf("release-session");
	assert.equal(await createOwnHandler(a)(ctx, () => "a"), "a", "a claims the session");
	b.release(ctx);
	assert.equal(ownerTable().get("release-session"), a.owner, "a non-owner release leaves the entry intact");
	assert.equal(await createOwnHandler(b)(ctx, () => "b"), undefined, "b is still inert");
	a.release(ctx);
	assert.equal(ownerTable().has("release-session"), false, "the owner release removes the entry");
	assert.equal(await createOwnHandler(b)(ctx, () => "b"), "b", "a fresh activation reclaims the session");
	ok("release：非 owner 不删表项，owner 交还后新副本重新抢占");
}

{
	resetOwnership();
	// 同一路径的两个 token：路径相同也不允许后来者交还别人的归属。
	const first = createOwnership({ owner: "/proj/same-owner" });
	const second = createOwnership({ owner: "/proj/same-owner" });
	const ctx = ctxOf("token-session");
	assert.equal(first.owns(ctx), true, "the first token claims");
	second.release(ctx);
	assert.equal(ownerTable().get("token-session"), first.owner, "a wrong token cannot release by path alone");
	assert.equal(first.owns(ctx), true, "the first token is still the owner");
	first.release(ctx);
	assert.equal(ownerTable().has("token-session"), false, "the matching token releases");
	ok("release 还认 token：同路径的错误 token 不删表项");
}

// 8. 装配级：真实 activate() + 假 pi 记录 pi.on handler；同一 sessionId 只有一份产生副作用。
{
	resetOwnership();
	const previous = process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
	delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
	try {
		function fakeApi(): { api: FakeExtensionApi; handlers: Map<string, EventHandler> } {
			const handlers = new Map<string, EventHandler>();
			return {
				api: {
					on(event, fn) { handlers.set(event, fn); },
					registerCommand() {},
					getAllTools: () => [],
				},
				handlers,
			};
		}

		const first = fakeApi();
		const second = fakeApi();
		activate(first.api as never);
		activate(second.api as never);
		const discoverA = first.handlers.get("resources_discover");
		const discoverB = second.handlers.get("resources_discover");
		assert.ok(discoverA && discoverB, "both activations register resources_discover");

		const noticesA: Notice[] = [];
		const noticesB: Notice[] = [];
		const ctxA = ctxOf("assembly-session", noticesA);
		const ctxB = ctxOf("assembly-session", noticesB);
		const event = { type: "resources_discover", cwd: "/repo", reason: "startup" };
		const resultA = (await discoverA(event, ctxA)) as { skillPaths?: string[] } | undefined;
		const resultB = (await discoverB(event, ctxB)) as { skillPaths?: string[] } | undefined;
		assert.ok(resultA?.skillPaths?.length, "the active registration produces the skill paths");
		assert.equal(resultB, undefined, "the inert registration produces no result at all");
		assert.equal(noticesA.length, 0, "the active registration is silent");
		assert.equal(noticesB.length, 1, "the inert registration warns through ctx.ui.notify");
		assert.match(noticesB[0].message, /loaded twice/, "the warning names the double load");
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_EXTENSION_BINDINGS;
		else process.env.PI_SUBAGENT_EXTENSION_BINDINGS = previous;
	}
	ok("activate() 装配：两个注册同会话只一份有副作用，另一份返回 undefined 并告警");
}

console.log(`\npi-subagents-extend session ownership tests passed (${passed} cases)`);

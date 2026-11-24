// 探针开着的时候，spec 里必须带 `watch`。
//
// 这是「内核观察到写入」这条链的上游：judge 把写范围放进 spec 的 watch，helper 才会挂 inotify，
// tool-result 才读得到 `<spec>.observe`。少这一格，下游两半的测试都还是绿的——helper 的集成用例
// 自己写 spec，plugin 的用例自己造观察文件——只有真正派单的子代理拿不到任何写活动证据。
//
// 反过来也要成立：没开探针时不能带 `watch`。helper 的 spec 解析是 deny_unknown_fields，
// 一个认不得 `watch` 的旧 helper 会把整份 spec 判死，没开探针的会话不该因为这一格而全军覆没。

import assert from "node:assert/strict";

import { handler, specOf, workdir } from "../harness.ts";

function payload(probe: boolean): string {
	return JSON.stringify({
		"pi-subagents-extend/1": {
			scope: ["."],
			writeScope: ["src/**"],
			...(probe ? { probe: { repeatBash: 3 } } : {}),
			bash: { allow: ["git status"] },
		},
	});
}

{
	const h = await handler({ cwd: workdir, bindings: payload(true) });
	const input = { command: "git status" };
	assert.equal(await h.call("bash", input), undefined, "命令照常放行");
	const spec = specOf(input.command) as unknown as Record<string, unknown>;
	const watch = spec.watch;
	assert.ok(
		Array.isArray(watch) && watch.length > 0,
		`探针打开时 spec 要带 watch，否则 helper 不挂 inotify：${JSON.stringify(spec)}`,
	);
	assert.ok(
		(watch as string[]).some((dir) => dir.endsWith("/src")),
		`watch 要覆盖写范围：${JSON.stringify(watch)}`,
	);
}

{
	// `probe: false` 是真关掉探针的那一档（`parseProbeConfig` 返回 undefined，`w.probe` 才不存在）。
	// 这时不该付观察的代价：没有消费方，却每次都多一个 inotify 线程和一次文件读。
	const h = await handler({
		cwd: workdir,
		bindings: JSON.stringify({
			"pi-subagents-extend/1": {
				scope: ["."],
				writeScope: ["src/**"],
				probe: false,
				bash: { allow: ["git status"] },
			},
		}),
	});
	const input = { command: "git status" };
	assert.equal(await h.call("bash", input), undefined, "关掉探针不影响命令本身");
	const spec = specOf(input.command) as unknown as Record<string, unknown>;
	assert.ok(
		!("watch" in spec),
		`探针关掉时不该带 watch：没有消费方，只有代价 —— ${JSON.stringify(spec)}`,
	);
}

{
	// 探针开着但没有写授权：没有可观察的东西，`watch` 也不能出现（连 `[]` 都不行）。
	const h = await handler({
		cwd: workdir,
		bindings: JSON.stringify({
			"pi-subagents-extend/1": { scope: ["."], readOnly: true, probe: true, bash: { allow: ["git status"] } },
		}),
	});
	const input = { command: "git status" };
	assert.equal(await h.call("bash", input), undefined, "只读任务照常跑命令");
	const spec = specOf(input.command) as unknown as Record<string, unknown>;
	assert.ok(
		!("watch" in spec),
		`没有写范围就没有 watch，别给每次 bash 都挂一个空监视 —— ${JSON.stringify(spec)}`,
	);
}

console.log("观察写入的 spec 接线：有写范围就带 watch，没有就不带");

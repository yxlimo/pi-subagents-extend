// Types for the offline test harness.
//
// The suites drive `activate()` with a hand-written stand-in for pi's ExtensionAPI
// rather than the real one: the extension only calls `on`, `registerCommand` and
// reads the context object, so a real API object would drag in most of pi to test
// a handful of fields. These interfaces describe exactly the surface the suites
// use, which is also what makes a typo in an event name or a context field a
// compile error instead of a test that silently asserts nothing.

/** What the extension returns to block a call. `terminate` is the hard stop. */
export interface Denial {
	block: true
	reason: string
	terminate?: boolean
}

/** `undefined` means the call was allowed. */
export type Outcome = Denial | undefined

/** The spec the extension writes for a rewritten bash command. */
export interface SandboxSpec {
	cwd: string
	read: string[]
	write: string[]
	/** The directory the helper shadows with a private tmpfs; absent means /tmp. */
	tmp?: string
	offline: boolean
	/** Seconds without CPU before the helper kills the tree; absent means no watchdog. */
	stallSeconds?: number
	env: Record<string, string>
}

/** `notify` takes an optional level ("warning" and so on); the suites assert on it. */
export interface SessionNotice {
	message: string
	level?: string
}

export interface SessionContext {
	cwd: string
	ui: { notify(message: string, level?: string): void }
	actions?: { abort(): void }
}

/** A context file as pi hands it over: mutable content, that is the whole point. */
export interface ContextFile {
	path: string
	content: string
}

/** The systemPromptOptions fields the extension touches. */
export interface PromptOptions {
	contextFiles?: ContextFile[]
	sections?: Record<string, string[]>
}

/** The event fields the suites actually read. Anything else stays unknown. */
export interface EventPayload {
	type?: string
	messages?: unknown[]
	systemPromptOptions?: PromptOptions
	[key: string]: unknown
}

/**
 * One registered event handler. Event payloads differ per event, and the suites read
 * one or two fields off each; a per-event union would add no safety in a test file.
 */
export type EventHandler = (event: EventPayload, ctx: SessionContext) => Promise<unknown> | unknown

export interface CommandSpec {
	handler(args: string, ctx: SessionContext): Promise<void> | void
}

/** The subset of pi's ExtensionAPI the extension touches. */
export interface FakeExtensionApi {
	on(event: string, handler: EventHandler): void
	registerCommand(name: string, spec: CommandSpec): void
	/** Optional: the host's tool registry, which the extension reads for path-argument names. */
	getAllTools?(): Array<{ name: string; parameters?: unknown }>
}

/** The extension module as the suites see it. */
export interface ExtensionModule {
	activate(pi: FakeExtensionApi): void
	/** 扫描用的排序比较器，单独暴露出来以便钉住「顺序不随文件系统变化」。 */
	sortByName<T extends { name: string }>(entries: T[]): T[]
	/** 依赖闸门的扫描范围，暴露出来以便钉住 200 个目录的上限。 */
	dependencyScope(cwd: string, ignored: string[]): string[]
	/** helper 的候选路径，暴露出来以便钉住「打包的平台二进制优先、cargo 产物也是候选」。 */
	helperCandidates(here: string, platform?: string, arch?: string): string[]
	/** 路径归一，暴露出来以便钉住「与 helper 的 resolve_comparable 一致」。 */
	resolveComparable(path: string): string
}

export interface HandlerOptions {
	bindings?: string
	cwd?: string
	/** Fake tool registry, for the schema-derived path-argument lookup. */
	piTools?: Array<{ name: string; parameters?: unknown }>
}

/** What the tool_result handler returns: the content array, possibly patched. */
export interface PatchedResult {
	content: Array<{ type: string; text: string }>
}

/** One message in the table the `context` hook rewrites. */
export interface MessageLike {
	role?: string
	customType?: string
	content?: string | { type?: string; text?: string }[]
}

/** The rewritten message table the `context` hook returns. */
export interface AnnotatedMessages {
	messages: MessageLike[]
}

/** What `handler()` returns: the activated extension, callable from a test. */
export interface Harness {
	call(toolName: string, input?: Record<string, unknown>, toolCallId?: string): Promise<Outcome>
	result(
		toolName: string,
		content: unknown,
		isError?: boolean,
		toolCallId?: string,
	): Promise<PatchedResult | undefined>
	context(messages: unknown[]): Promise<AnnotatedMessages | undefined>
	shutdown(): Promise<void>
	aborts: string[]
	ui: string[]
	commands: Record<string, CommandSpec>
	restore(): void
}

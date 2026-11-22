/**
 * bash 白名单：唯一入口。
 *
 * 实现按层拆在 src/bash/ 下（env / programs / network / tokens / rules / unreachable），
 * 这里只转出口；调用方一律从本文件 import。
 */

export { deniedEnvAssignment, leadingAssignments, type LeadingAssignments } from "./env.ts";
export { commandAccess, isUnknownProgram } from "./programs.ts";
export { requiresNetwork } from "./network.ts";
export { commandSegments, pathCandidates, shellTokens, tokens } from "./tokens.ts";
export {
	allEntries,
	classifyCommand,
	commandMatches,
	deniedEntry,
	firstToken,
	listedJoin,
	MAX_LISTED,
	parseBashRule,
	stringList,
	type BashAccess,
	type BashMatch,
	type BashRule,
	type UnreachableEntry,
} from "./rules.ts";
export { commandNeedsNoManifest, unreachableEntries } from "./unreachable.ts";

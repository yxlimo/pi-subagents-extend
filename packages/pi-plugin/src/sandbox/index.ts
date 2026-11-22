/**
 * SANDBOX 层 · barrel：bash 沙箱按主题拆成三个模块，这里原样转出全部既有公开面，
 * 调用方（index.ts、wiring/*）的 import 不变：
 * - helper.ts：helper 定位与能力探测（--describe）、缺 helper / ABI 不足的开场拦截、pnpm store 描述
 * - grants.ts：可写路径推导（写范围、git、产物目录、工具链缓存、交付物）与被剔授权上报
 * - spec.ts：spec 的构建与落盘（生命周期）、沙箱内环境变量、命令包装
 * 各模块除 memo（gitDirsCache、pnpmStoreCache、helperCache、toolchainCacheDirMemo、specSeq，
 * 语义上仍是纯推导）外不持有会话状态；index.ts 只做接线。
 */
export { bashBlocker, describeHelper, describePnpmStore, detectPnpmStore, helperCandidates, helperPath, type HelperCapabilities } from "./helper.ts";
export { reportHiddenGrants, reportedHiddenGrants, SANDBOX_DEVICE_PATHS, sandboxWritableDirs, setDeliverableTargetPath, stateDir, toolchainCacheDir } from "./grants.ts";
export { buildSpec, dropSpecFile, scratchDir, sweepStaleSpecFiles, wrapInSandbox, writeSpecFile } from "./spec.ts";

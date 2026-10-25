/**
 * Run modes for the coding agent.
 */

export { InteractiveMode, type InteractiveModeOptions } from "./interactive/interactive-mode.ts";
export type { JsonAgentSessionEvent } from "./json-event.ts";
export { type PrintModeOptions, runPrintMode } from "./print-mode.ts";
export { isControlCommand, runControlMode } from "./rpc/control-mode.ts";
export {
	NEK_CONTROL_COMMANDS,
	NEK_GUI_PROTOCOL_VERSION,
	NEK_STRUCTURED_KINDS,
	NEK_THINKING_LEVELS,
	type RpcGuiCommand,
	type RpcGuiInfo,
	type RpcGuiResponseData,
	type RpcInfo,
	type RpcProcessMode,
} from "./rpc/gui/protocol.ts";
export { type ModelInfo, RpcClient, type RpcClientOptions, type RpcEventListener } from "./rpc/rpc-client.ts";
export { runRpcMode } from "./rpc/rpc-mode.ts";
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc/rpc-types.ts";

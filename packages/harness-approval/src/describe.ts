/**
 * `ai-sdk-harness-approval/describe`: how the package reads a tool call — what it does, its
 * command and the commands of its script, its files —, with no peer dependency, its types
 * included: for an interface that shows approval requests and needs nothing else.
 */
export type { ToolRequest } from './definitions/policy.js';
export type { ToolKind } from './definitions/tools.js';
export type {
  DescribeToolCallOptions,
  ToolCallAction,
  ToolCallSummary,
} from './describe/describe-tool-call.js';
export { describeToolCall, TOOL_CALL_TITLES } from './describe/describe-tool-call.js';
export { commandOf, pathsOf, toolKindOf } from './utils/requests.js';
export type { CommandSegment } from './utils/shell.js';
export { commandSegments } from './utils/shell.js';

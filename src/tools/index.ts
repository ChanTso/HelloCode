import { createFileTools } from './files.js';
import { createShellTool } from './shell.js';
import type { ToolSpec } from './types.js';

export function createTools(): ToolSpec[] {
  return [...createFileTools(), createShellTool()];
}

export { ToolRegistry, type ToolExecutionResult } from './registry.js';

// transcriptParser.ts - OpenCode version
// Parses OpenCode SQLite message format to track agent activity

import * as path from 'path';
import type * as vscode from 'vscode';
import type { AgentState } from './types.js';
import {
	cancelWaitingTimer,
	startWaitingTimer,
	clearAgentActivity,
	startPermissionTimer,
	cancelPermissionTimer,
} from './timerManager.js';
import {
	TOOL_DONE_DELAY_MS,
	TEXT_IDLE_DELAY_MS,
	BASH_COMMAND_DISPLAY_MAX_LENGTH,
	TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
	OPENCODE_TOOLS,
} from './constants.js';

export const PERMISSION_EXEMPT_TOOLS = new Set(['agent']);

// Map OpenCode tool names to display status
export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
	const base = (p: unknown) => typeof p === 'string' ? path.basename(p) : '';
	switch (toolName) {
		case 'view': return `Reading ${base(input.file_path)}`;
		case 'edit': return `Editing ${base(input.file_path)}`;
		case 'write': return `Writing ${base(input.file_path)}`;
		case 'patch': return `Patching ${base(input.file_path)}`;
		case 'bash': {
			const cmd = (input.command as string) || '';
			return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
		}
		case 'glob': return 'Searching files';
		case 'grep': return 'Searching code';
		case 'ls': return 'Listing directory';
		case 'fetch': return 'Fetching web content';
		case 'sourcegraph': return 'Searching code';
		case 'agent': {
			const prompt = typeof input.prompt === 'string' ? input.prompt : '';
			return prompt ? `Subtask: ${prompt.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? prompt.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : prompt}` : 'Running subtask';
		}
		case 'diagnostics': return `Diagnostics for ${base(input.file_path)}`;
		default: return `Using ${toolName}`;
	}
}

// Parse OpenCode message data (JSON in the data column)
interface OpenCodeMessage {
	role: 'user' | 'assistant' | 'system';
	time: { created: number; completed?: number };
	model?: { providerID: string; modelID: string };
	agent?: string;
	path?: { cwd: string; root: string };
	tokens?: { total: number; input: number; output: number; reasoning: number; cache?: { read: number; write: number } };
	finish?: string;
	content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown>; id?: string }>;
	tool_calls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
}

export function processOpenCodeMessage(
	agentId: number,
	messageData: OpenCodeMessage,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	try {
		// Assistant message with tool calls
		if (messageData.role === 'assistant' && messageData.tool_calls && messageData.tool_calls.length > 0) {
			cancelWaitingTimer(agentId, waitingTimers);
			agent.isWaiting = false;
			agent.hadToolsInTurn = true;
			webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });

			let hasNonExemptTool = false;
			for (const toolCall of messageData.tool_calls) {
				const toolName = toolCall.name || '';
				const status = formatToolStatus(toolName, toolCall.input || {});
				console.log(`[Pixel Agents OpenCode] Agent ${agentId} tool start: ${toolCall.id} ${status}`);
				
				agent.activeToolIds.add(toolCall.id);
				agent.activeToolStatuses.set(toolCall.id, status);
				agent.activeToolNames.set(toolCall.id, toolName);

				if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
					hasNonExemptTool = true;
				}

				webview?.postMessage({
					type: 'agentToolStart',
					id: agentId,
					toolId: toolCall.id,
					status,
				});
			}

			if (hasNonExemptTool) {
				startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
			}
		}
		// User message (tool results or new input)
		else if (messageData.role === 'user') {
			// Check if this is a tool result
			const hasToolResult = messageData.content?.some(b => b.type === 'tool_result');
			
			if (hasToolResult) {
				for (const block of messageData.content || []) {
					if (block.type === 'tool_result' && block.id) {
						console.log(`[Pixel Agents OpenCode] Agent ${agentId} tool done: ${block.id}`);
						
						// If completed tool was an agent sub-task, clear subagent tools
						if (agent.activeToolNames.get(block.id) === 'agent') {
							agent.activeSubagentToolIds.delete(block.id);
							agent.activeSubagentToolNames.delete(block.id);
							webview?.postMessage({
								type: 'subagentClear',
								id: agentId,
								parentToolId: block.id,
							});
						}

						agent.activeToolIds.delete(block.id);
						agent.activeToolStatuses.delete(block.id);
						agent.activeToolNames.delete(block.id);

						const toolId = block.id;
						setTimeout(() => {
							webview?.postMessage({
								type: 'agentToolDone',
								id: agentId,
								toolId,
							});
						}, TOOL_DONE_DELAY_MS);
					}
				}

				// All tools completed — allow text-idle timer as fallback
				if (agent.activeToolIds.size === 0) {
					agent.hadToolsInTurn = false;
				}
			} else {
				// New user text prompt — new turn starting
				cancelWaitingTimer(agentId, waitingTimers);
				clearAgentActivity(agent, agentId, permissionTimers, webview);
				agent.hadToolsInTurn = false;
			}
		}
		// Turn completed (finish_reason indicates done)
		else if (messageData.finish === 'stop' || messageData.finish === 'tool-calls') {
			// Turn ended — mark as waiting for user
			cancelWaitingTimer(agentId, waitingTimers);
			cancelPermissionTimer(agentId, permissionTimers);

			// Clean up any stale tool state
			if (agent.activeToolIds.size > 0) {
				agent.activeToolIds.clear();
				agent.activeToolStatuses.clear();
				agent.activeToolNames.clear();
				agent.activeSubagentToolIds.clear();
				agent.activeSubagentToolNames.clear();
				webview?.postMessage({ type: 'agentToolsClear', id: agentId });
			}

			agent.isWaiting = true;
			agent.permissionSent = false;
			agent.hadToolsInTurn = false;
			webview?.postMessage({
				type: 'agentStatus',
				id: agentId,
				status: 'waiting',
			});
		}
		// Text-only response — use silence-based timer for idle detection
		else if (messageData.role === 'assistant' && 
				 messageData.content && 
				 messageData.content.length > 0 && 
				 !messageData.tool_calls &&
				 !agent.hadToolsInTurn) {
			startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, webview);
		}
	} catch (e) {
		console.log(`[Pixel Agents OpenCode] Parse error for agent ${agentId}: ${e}`);
	}
}

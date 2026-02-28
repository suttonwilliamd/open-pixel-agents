import type * as vscode from 'vscode';

// Agent state for Claude Code (original)
export interface AgentState {
	id: number;
	terminalRef: vscode.Terminal;
	projectDir: string;
	jsonlFile: string;
	fileOffset: number;
	lineBuffer: string;
	activeToolIds: Set<string>;
	activeToolStatuses: Map<string, string>;
	activeToolNames: Map<string, string>;
	activeSubagentToolIds: Map<string, Set<string>>; // parentToolId → active sub-tool IDs
	activeSubagentToolNames: Map<string, Map<string, string>>; // parentToolId → (subToolId → toolName)
	isWaiting: boolean;
	permissionSent: boolean;
	hadToolsInTurn: boolean;
	/** Workspace folder name (only set for multi-root workspaces) */
	folderName?: string;
}

// OpenCode-specific agent state
export interface OpenCodeAgentState {
	id: number;
	sessionId: string;
	sessionTitle: string;
	projectDir: string;
	lastDbOffset: number;
	activeToolIds: Set<string>;
	activeToolStatuses: Map<string, string>;
	activeToolNames: Map<string, string>;
	activeSubagentToolIds: Map<string, Set<string>>;
	activeSubagentToolNames: Map<string, Map<string, string>>;
	isWaiting: boolean;
	permissionSent: boolean;
	hadToolsInTurn: boolean;
	folderName?: string;
}

export interface PersistedAgent {
	id: number;
	terminalName: string;
	jsonlFile: string;
	projectDir: string;
	/** Workspace folder name (only set for multi-root workspaces) */
	folderName?: string;
}

// OpenCode persisted agent
export interface PersistedOpenCodeAgent {
	id: number;
	sessionId: string;
	sessionTitle: string;
	projectDir: string;
	lastDbOffset: number;
	folderName?: string;
}

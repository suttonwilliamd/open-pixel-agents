// agentManager.ts - OpenCode version
// Manages OpenCode sessions instead of Claude Code terminals

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import type { OpenCodeAgentState, PersistedOpenCodeAgent } from './types.js';
import { cancelWaitingTimer, cancelPermissionTimer } from './timerManager.js';
import { startSessionWatching, stopSessionWatching, getActiveSessions, openCodeDbExists } from './fileWatcher.js';
import { DB_POLL_INTERVAL_MS, TERMINAL_NAME_PREFIX, WORKSPACE_KEY_AGENTS, WORKSPACE_KEY_AGENT_SEATS, OPENCODE_DB_PATH } from './constants.js';
import { migrateAndLoadLayout } from './layoutPersistence.js';

export function getProjectDirPath(cwd?: string): string | null {
	const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspacePath) return null;
	const dirName = workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
	const projectDir = path.join(os.homedir(), '.opencode', 'projects', dirName);
	console.log(`[Pixel Agents OpenCode] Project dir: ${workspacePath} → ${dirName}`);
	return projectDir;
}

export function checkOpenCodeInstalled(): boolean {
	try {
		const { execSync } = require('child_process');
		execSync('opencode --version', { encoding: 'utf-8' });
		return true;
	} catch {
		return false;
	}
}

export async function launchNewSession(
	nextAgentIdRef: { current: number },
	agents: Map<number, OpenCodeAgentState>,
	activeAgentIdRef: { current: number | null },
	sessionPollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
	folderPath?: string,
): Promise<void> {
	// Check OpenCode is installed
	if (!checkOpenCodeInstalled()) {
		vscode.window.showErrorMessage('OpenCode is not installed. Please install it from https://opencode.ai');
		return;
	}

	// Check database exists
	if (!openCodeDbExists()) {
		vscode.window.showErrorMessage('OpenCode database not found. Please run OpenCode first.');
		return;
	}

	const folders = vscode.workspace.workspaceFolders;
	const cwd = folderPath || folders?.[0]?.uri.fsPath;
	const isMultiRoot = !!(folders && folders.length > 1);
	const folderName = isMultiRoot && cwd ? path.basename(cwd) : undefined;
	const projectDir = cwd || '.';

	// Get current sessions to find the newest one
	const sessionsBefore = getActiveSessions();
	const sessionsBeforeIds = new Set(sessionsBefore.map(s => s.id));

	// Open OpenCode in the workspace folder
	const terminal = vscode.window.createTerminal({
		name: `${TERMINAL_NAME_PREFIX}`,
		cwd,
	});
	terminal.show();
	terminal.sendText('opencode .');

	// Wait a moment for session to be created, then find it
	await new Promise(resolve => setTimeout(resolve, 2000));

	const sessionsAfter = getActiveSessions();
	const newSession = sessionsAfter.find(s => !sessionsBeforeIds.has(s.id));

	if (!newSession) {
		console.log(`[Pixel Agents OpenCode] Could not find new session`);
		return;
	}

	// Create agent for this session
	const id = nextAgentIdRef.current++;
	const agent: OpenCodeAgentState = {
		id,
		sessionId: newSession.id,
		sessionTitle: newSession.title,
		projectDir,
		lastDbOffset: 0,
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: false,
		permissionSent: false,
		hadToolsInTurn: false,
		folderName,
	};

	agents.set(id, agent);
	activeAgentIdRef.current = id;
	persistAgents();

	console.log(`[Pixel Agents OpenCode] Agent ${id}: created for session ${newSession.id} - ${newSession.title}`);
	webview?.postMessage({ type: 'agentCreated', id, folderName, sessionTitle: newSession.title });

	// Start watching the session for activity
	startSessionWatching(
		id,
		newSession.id,
		agents,
		sessionPollingTimers,
		waitingTimers,
		permissionTimers,
		webview,
	);
}

export function adoptExistingSession(
	session: { id: string; title: string; directory: string },
	nextAgentIdRef: { current: number },
	agents: Map<number, OpenCodeAgentState>,
	activeAgentIdRef: { current: number | null },
	sessionPollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): void {
	// Check if we already track this session
	for (const agent of agents.values()) {
		if (agent.sessionId === session.id) {
			console.log(`[Pixel Agents OpenCode] Session ${session.id} already tracked`);
			return;
		}
	}

	const id = nextAgentIdRef.current++;
	const folderName = session.directory ? path.basename(session.directory) : undefined;
	
	const agent: OpenCodeAgentState = {
		id,
		sessionId: session.id,
		sessionTitle: session.title,
		projectDir: session.directory || '.',
		lastDbOffset: 0,
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: false,
		permissionSent: false,
		hadToolsInTurn: false,
		folderName,
	};

	agents.set(id, agent);
	activeAgentIdRef.current = id;
	persistAgents();

	console.log(`[Pixel Agents OpenCode] Agent ${id}: adopted session ${session.id} - ${session.title}`);
	webview?.postMessage({ type: 'agentCreated', id, folderName, sessionTitle: session.title });

	startSessionWatching(
		id,
		session.id,
		agents,
		sessionPollingTimers,
		waitingTimers,
		permissionTimers,
		webview,
	);
}

export function removeAgent(
	agentId: number,
	agents: Map<number, OpenCodeAgentState>,
	sessionPollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	persist void,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	// Stop session polling
	stopSessionWatching(agentId, sessionPollingTimers);

	// Cancel timers
	cancelWaitingTimer(agentId, waitingTimers);
	cancelPermissionTimer(agentId, permissionTimers);

	// Remove from map
	agents.delete(agentId);
	persistAgents();
}

export function persistAgents(
	agents: Map<number, OpenCodeAgentState>,
	context: vscode.ExtensionContext,
): void {
	const persisted: PersistedOpenCodeAgent[] = [];
	for (const agent of agents.values()) {
		persisted.push({
			id: agent.id,
			sessionId: agent.sessionId,
			sessionTitle: agent.sessionTitle,
			projectDir: agent.projectDir,
			lastDbOffset: agent.lastDbOffset,
			folderName: agent.folderName,
		});
	}
	context.workspaceState.update(WORKSPACE_KEY_AGENTS, persisted);
}

export function restoreAgents(
	context: vscode.ExtensionContext,
	nextAgentIdRef: { current: number },
	agents: Map<number, OpenCodeAgentState>,
	sessionPollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	activeAgentIdRef: { current: number | null },
	webview: vscode.Webview | undefined,
	doPersist: () => void,
): void {
	const persisted = context.workspaceState.get<PersistedOpenCodeAgent[]>(WORKSPACE_KEY_AGENTS, []);
	if (persisted.length === 0) return;

	// Get current sessions from OpenCode
	const currentSessions = getActiveSessions();
	const currentSessionIds = new Set(currentSessions.map(s => s.id));

	let maxId = 0;

	for (const p of persisted) {
		// Only restore if session still exists
		if (!currentSessionIds.has(p.sessionId)) {
			console.log(`[Pixel Agents OpenCode] Session ${p.sessionId} no longer exists, skipping restore`);
			continue;
		}

		const session = currentSessions.find(s => s.id === p.sessionId)!;

		const agent: OpenCodeAgentState = {
			id: p.id,
			sessionId: p.sessionId,
			sessionTitle: p.sessionTitle,
			projectDir: p.projectDir,
			lastDbOffset: p.lastDbOffset,
			activeToolIds: new Set(),
			activeToolStatuses: new Map(),
			activeToolNames: new Map(),
			activeSubagentToolIds: new Map(),
			activeSubagentToolNames: new Map(),
			isWaiting: false,
			permissionSent: false,
			hadToolsInTurn: false,
			folderName: p.folderName,
		};

		agents.set(p.id, agent);
		console.log(`[Pixel Agents OpenCode] Restored agent ${p.id} → session "${p.sessionTitle}"`);

		if (p.id > maxId) maxId = p.id;

		// Start watching the session
		startSessionWatching(
			p.id,
			p.sessionId,
			agents,
			sessionPollingTimers,
			waitingTimers,
			permissionTimers,
			webview,
		);
	}

	// Advance counter past restored IDs
	if (maxId >= nextAgentIdRef.current) {
		nextAgentIdRef.current = maxId + 1;
	}

	// Re-persist cleaned-up list
	doPersist();
}

export function sendExistingAgents(
	agents: Map<number, OpenCodeAgentState>,
	context: vscode.ExtensionContext,
	webview: vscode.Webview | undefined,
): void {
	if (!webview) return;

	const agentData: Array<{ id: number; folderName?: string; sessionTitle: string }> = [];
	for (const [id, agent] of agents) {
		agentData.push({
			id,
			folderName: agent.folderName,
			sessionTitle: agent.sessionTitle,
		});
	}
	agentData.sort((a, b) => a.id - b.id);

	// Include persisted palette/seatId from separate key
	const agentMeta = context.workspaceState.get<Record<string, { palette?: number; seatId?: string }>>(WORKSPACE_KEY_AGENT_SEATS, {});

	console.log(`[Pixel Agents OpenCode] sendExistingAgents: agents=${JSON.stringify(agentData)}, meta=${JSON.stringify(agentMeta)}`);

	webview.postMessage({
		type: 'existingAgents',
		agents: agentData.map(a => a.id),
		agentMeta,
		folderNames: Object.fromEntries(
			agentData.filter(a => a.folderName).map(a => [a.id, a.folderName!])
		),
		sessionTitles: Object.fromEntries(
			agentData.map(a => [a.id, a.sessionTitle])
		),
	});

	sendCurrentAgentStatuses(agents, webview);
}

export function sendCurrentAgentStatuses(
	agents: Map<number, OpenCodeAgentState>,
	webview: vscode.Webview | undefined,
): void {
	if (!webview) return;

	for (const [agentId, agent] of agents) {
		// Re-send active tools
		for (const [toolId, status] of agent.activeToolStatuses) {
			webview.postMessage({
				type: 'agentToolStart',
				id: agentId,
				toolId,
				status,
			});
		}
		// Re-send waiting status
		if (agent.isWaiting) {
			webview.postMessage({
				type: 'agentStatus',
				id: agentId,
				status: 'waiting',
			});
		}
	}
}

export function sendLayout(
	context: vscode.ExtensionContext,
	webview: vscode.Webview | undefined,
	defaultLayout?: Record<string, unknown> | null,
): void {
	if (!webview) return;
	const layout = migrateAndLoadLayout(context, defaultLayout);
	webview.postMessage({
		type: 'layoutLoaded',
		layout,
	});
}

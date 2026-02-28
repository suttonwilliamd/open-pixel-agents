// fileWatcher.ts - OpenCode version
// Watches OpenCode SQLite database for session activity instead of JSONL files

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import type { AgentState } from './types.js';
import { cancelWaitingTimer, cancelPermissionTimer, clearAgentActivity } from './timerManager.js';
import { processOpenCodeMessage } from './transcriptParser.js';
import { DB_POLL_INTERVAL_MS, OPENCODE_DB_PATH, PROJECT_SCAN_INTERVAL_MS } from './constants.js';

interface SessionMessage {
	id: string;
	session_id: string;
	time_created: number;
	data: string;
}

// Get the user's home directory
function getHomeDir(): string {
	return os.homedir();
}

// Get OpenCode database path
export function getOpenCodeDbPath(): string {
	const home = getHomeDir();
	return path.join(home, OPENCODE_DB_PATH);
}

// Check if OpenCode database exists
export function openCodeDbExists(): boolean {
	const dbPath = getOpenCodeDbPath();
	return fs.existsSync(dbPath);
}

// Query messages from a specific session
export function querySessionMessages(
	dbPath: string,
	sessionId: string,
	sinceOffset: number
): SessionMessage[] {
	try {
		// Use OpenCode CLI to query DB (safer than raw SQL)
		const messages: SessionMessage[] = [];
		const { execSync } = require('child_process');
		
		// Query messages for this session since the last offset
		const query = `SELECT id, session_id, time_created, data FROM message WHERE session_id = '${sessionId}' AND time_created > ${sinceOffset} ORDER BY time_created ASC`;
		
		const result = execSync(`cmd /c "C:\\\\Users\\\\sutto\\\\AppData\\\\Local\\\\OpenCode\\\\opencode-cli.exe" db \\"${query}\\" --format json`, {
			encoding: 'utf-8',
			maxBuffer: 10 * 1024 * 1024
		});
		
		if (result && result.trim()) {
			const parsed = JSON.parse(result);
			if (Array.isArray(parsed)) {
				return parsed;
			}
		}
		return [];
	} catch (e) {
		console.log(`[Pixel Agents OpenCode] Query error: ${e}`);
		return [];
	}
}

// Start watching an OpenCode session for activity
export function startSessionWatching(
	agentId: number,
	sessionId: string,
	agents: Map<number, AgentState>,
	sessionPollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const dbPath = getOpenCodeDbPath();
	let lastMessageTime = Date.now();

	// Poll database for new messages
	const interval = setInterval(() => {
		const agent = agents.get(agentId);
		if (!agent) {
			clearInterval(interval);
			return;
		}

		try {
			// Query new messages since last check
			const messages = querySessionMessages(dbPath, sessionId, agent.lastDbOffset || 0);
			
			if (messages.length > 0) {
				// Update offset to latest message time
				const latestTime = messages[messages.length - 1].time_created;
				agent.lastDbOffset = latestTime;

				// Cancel idle timers when data is flowing
				cancelWaitingTimer(agentId, waitingTimers);
				cancelPermissionTimer(agentId, permissionTimers);
				if (agent.permissionSent) {
					agent.permissionSent = false;
					webview?.postMessage({ type: 'agentToolPermissionClear', id: agentId });
				}

				// Process each new message
				for (const msg of messages) {
					try {
						const messageData = JSON.parse(msg.data);
						processOpenCodeMessage(agentId, messageData, agents, waitingTimers, permissionTimers, webview);
					} catch (e) {
						console.log(`[Pixel Agents OpenCode] Error parsing message: ${e}`);
					}
				}
			}
		} catch (e) {
			console.log(`[Pixel Agents OpenCode] Poll error for agent ${agentId}: ${e}`);
		}
	}, DB_POLL_INTERVAL_MS);

	sessionPollingTimers.set(agentId, interval);
}

// Get list of active sessions from OpenCode database
export function getActiveSessions(): Array<{ id: string; title: string; directory: string }> {
	try {
		const { execSync } = require('child_process');
		const query = `SELECT id, title, directory FROM session ORDER BY time_updated DESC LIMIT 10`;
		
		const result = execSync(`cmd /c "C:\\\\Users\\\\sutto\\\\AppData\\\\Local\\\\OpenCode\\\\opencode-cli.exe" db \\"${query}\\" --format json`, {
			encoding: 'utf-8',
			maxBuffer: 5 * 1024 * 1024
		});
		
		if (result && result.trim()) {
			const parsed = JSON.parse(result);
			if (Array.isArray(parsed)) {
				return parsed;
			}
		}
		return [];
	} catch (e) {
		console.log(`[Pixel Agents OpenCode] Error getting sessions: ${e}`);
		return [];
	}
}

// Export for use by agentManager
export function stopSessionWatching(
	agentId: number,
	sessionPollingTimers: Map<number, ReturnType<typeof setInterval>>,
): void {
	const timer = sessionPollingTimers.get(agentId);
	if (timer) {
		clearInterval(timer);
		sessionPollingTimers.delete(agentId);
	}
}

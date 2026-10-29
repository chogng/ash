import type { AgentVoiceSource } from '../../../platform/agentHost/common/agent.js';
import type { IAgentVoiceService } from '../../../platform/agentHost/common/agentService.js';
import type { ISessionProviderScope } from './sessionProviderScopeService.js';

/** A retained conversation borrows voice from its host; media and task leases stay with that host. */
export function createSessionVoiceService(scope: ISessionProviderScope): IAgentVoiceService | undefined {
	const backend = scope.services.host.agentVoice;
	if (!backend) {
		return undefined;
	}
	const current = (): boolean => {
		try {
			scope.assertCurrent();
			return true;
		} catch {
			return false;
		}
	};
	const identity = <T extends AgentVoiceSource>(value: T): T => ({
		...value,
		sessionId: scope.identity(value.sessionId),
		threadId: scope.identity(value.threadId),
	});
	const params = <T extends AgentVoiceSource>(value: T): T => ({
		...value,
		sessionId: scope.backendIdentity(value.sessionId),
		threadId: scope.backendIdentity(value.threadId),
	});
	const run = async <T>(operation: () => Promise<T>): Promise<T> => {
		scope.assertCurrent();
		const result = await operation();
		scope.assertCurrent();
		return result;
	};
	return {
		get isAvailable() {
			return current() && backend.isAvailable;
		},
		get state() {
			const state = current() ? backend.state : undefined;
			return state && identity(state);
		},
		onDidChange: (listener, thisArgs, disposables) =>
			backend.onDidChange(
				() => {
					if (current()) {
						listener.call(thisArgs, undefined);
					}
				},
				undefined,
				disposables,
			),
		onDidRequestTask: (listener, thisArgs, disposables) =>
			backend.onDidRequestTask(
				request => {
					if (current()) {
						listener.call(thisArgs, identity(request));
					}
				},
				undefined,
				disposables,
			),
		getOptions: () => run(() => backend.getOptions()),
		start: (source, selection, signal) => run(async () => identity(await backend.start(params(source), selection, signal))),
		stop: () => run(() => backend.stop()),
		interrupt: () => run(() => backend.interrupt()),
		setMuted: muted => run(() => backend.setMuted(muted)),
		setInputMode: mode => run(() => backend.setInputMode(mode)),
		pttDown: id => run(() => backend.pttDown(id)),
		pttUp: id => run(() => backend.pttUp(id)),
		rejectTask: request => run(() => backend.rejectTask(params(request))),
	};
}

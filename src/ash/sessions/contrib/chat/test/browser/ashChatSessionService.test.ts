import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import type { AgentSession, SessionCreateParams } from '../../../../../platform/agentHost/common/agent.js';
import { IAgentConnection } from '../../../../../platform/agentHost/common/agentService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { AshChatSessionService } from '../../browser/ashChatSessionService.js';

test('Ash Chat retries a saved draft with the original creation identity and restores only Chat records', async () => {
	const session: AgentSession = {
		sessionId: 'saved-session', surface: 'chat', title: 'Existing Ash Chat', status: 'active',
		manager: { status: 'idle', statusChangedAtUnixMs: 0 },
		threads: [{ threadId: 'saved-root', title: 'Root', status: 'active' }],
	};
	const calls: unknown[] = [];
	using services = new InstantiationService();
	services.registerInstance(IAgentConnection, {
		appServer: { connectionGeneration: 1, onConnectionState: Event.None },
		session: {
			onDidChangeSession: Event.None, onDidDeleteSession: Event.None,
			async create(params: SessionCreateParams) { calls.push(params); return { session }; },
			async unsubscribe(params: { sessionId: string; }) { calls.push(params); },
			async readCatalog({ sessionId }: { sessionId: string; }) {
				return { session: sessionId === session.sessionId ? session : { ...session, sessionId, surface: undefined } };
			},
		},
	} as unknown as IAgentConnection);
	using logger = new NullLoggerService();
	services.registerInstance(ILogService, logger);
	using chat = services.createInstance(AshChatSessionService);
	const expected = { sessionId: 'saved-session', threadId: 'saved-root' };
	assert.deepEqual(await chat.create('saved-draft'), expected);
	assert.deepEqual(await chat.create('saved-draft'), expected);
	const request = { commandId: 'desktop-session-saved-draft', title: '', surface: 'chat', executionTarget: null, agent: { type: 'default' } };
	assert.deepEqual(calls, [request, { sessionId: 'saved-session' }, request, { sessionId: 'saved-session' }]);
	assert.equal(await chat.read('saved-session'), session);
	assert.equal(await chat.read('legacy-code-session'), undefined);
});

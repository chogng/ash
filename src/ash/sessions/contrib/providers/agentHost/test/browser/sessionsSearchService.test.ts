import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import type { AgentHostInputCompletionRequest, AgentHostInputCompletionItem } from '../../../../../../platform/agentHost/common/agent.js';
import { createDisconnectedRendererApi } from '../../../../../../workbench/browser/rendererApi.js';
import { ISessionProviderScopeService, type ISessionProviderScope } from '../../../../../browser/agentHost/sessionProviderScopeService.js';
import { ISessionsProvidersService } from '../../../../../services/sessions/browser/sessionsProvidersService.js';
import { SessionsSearchService } from '../../browser/sessionsSearchService.js';

test('completion routing captures provider identities and directories and cancels when that host retires', async () => {
	using resources = new DisposableStore();
	const services = resources.add(new InstantiationService());
	const connection = resources.add(new Emitter<void>());
	const changes = resources.add(new Emitter<void>());
	const response = new DeferredPromise<readonly AgentHostInputCompletionItem[]>();
	const calls: AgentHostInputCompletionRequest[] = [];
	const started = new DeferredPromise<void>();
	let backendSignal: AbortSignal | undefined;
	const base = createDisconnectedRendererApi();
	const host = {
		...base, fs: { ...base.fs, onDidChangeConnection: connection.event }, completions: {
			onDidChangeConnection: connection.event, getTriggerCharacters: () => ['#', '$'], complete: async (request: AgentHostInputCompletionRequest, signal: AbortSignal) => { calls.push(request); backendSignal = signal; await started.complete(); return response.p; },
		}
	};
	const scope = { providerId: 'remote', services: { host }, thread: host.thread, identity: (value: string) => `remote:${value}`, backendIdentity: (value: string) => { assert.ok(value.startsWith('remote:')); return value.slice(7); }, assertCurrent: () => { } } as unknown as ISessionProviderScope;
	let selected: ISessionProviderScope | undefined = scope;
	services.registerInstance(ISessionProviderScopeService, { onDidChange: changes.event, onDidChangeScopes: Event.None, getScopes: () => [scope], getScope: id => { if (id) assert.equal(id, 'remote:session'); if (!selected) throw new Error('Provider removed'); return selected; }, getProviderScope: () => scope, createScope: () => { throw new Error('Unexpected UI creation'); } });
	services.registerInstance(ISessionsProvidersService, { getProviders: () => [] } as unknown as ISessionsProvidersService);
	const service = services.createInstance(SessionsSearchService, 'primary', () => ({ id: 'primary', folders: [] }));
	let notifications = 0;
	resources.add(service.onDidChangeConnection(() => notifications++));
	changes.fire();
	assert.equal(notifications, 0);
	const directory = { resource: URI.parse('ash-remote://ssh+remote/work'), target: { type: 'workspace' as const, dirId: `session:${encodeURIComponent('remote:session')}:${encodeURIComponent('/work')}` } };
	const pending = service.complete({ text: '#file', offset: 5, sessionId: 'remote:session', threadId: 'remote:thread', directories: [directory] }, new AbortController().signal);
	const rejected = assert.rejects(pending, isCancellationError);
	await started.p;
	selected = { ...scope, providerId: 'other' };
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], { text: '#file', offset: 5, sessionId: 'session', threadId: 'thread', directories: [{ resource: directory.resource, target: { type: 'session', sessionId: 'session', path: '/work' } }] });
	connection.fire();
	assert.equal(backendSignal?.aborted, true);
	assert.equal(notifications, 1);
	selected = undefined;
	changes.fire();
	assert.equal(notifications, 2);
	assert.deepEqual(service.getTriggerCharacters(), []);
	await rejected;
	await response.complete([]);
});

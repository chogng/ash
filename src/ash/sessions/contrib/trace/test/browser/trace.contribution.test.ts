import '../../../../../editor/test/browser/testEditorDom.js';
import { IContextKeyService, ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ISessionsLayoutService, type ISessionsEntry } from '../../../../services/layout/common/sessionsLayoutService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import '../../browser/trace.contribution.js';

function registerHosts(services: InstantiationService, opened: ISessionsEntry[], stored: Map<string, string>): void {
	services.registerInstance(IContextKeyService, new ContextKeyService());
	services.registerInstance(IStorageService, { get: (key: string) => stored.get(key), store: (key: string, value: string) => stored.set(key, value) } as unknown as IStorageService);
	services.registerInstance(ISessionsLayoutService, { openEntry: async (entry: ISessionsEntry) => { opened.push(entry); } } as unknown as ISessionsLayoutService);
}

suite('Sessions Execution Trace entry', () => {
	for (const turnId of ['child-turn', undefined]) {
		test(`opens the active child Thread at its recorded Turn ${String(turnId)}`, async () => {
			using services = new InstantiationService();
			const opened: ISessionsEntry[] = [];
			const stored = new Map([['agentTrace.lastResource', 'ash-agent-trace:/previous']]);
			registerHosts(services, opened, stored);
			services.registerInstance(ISessionsService, { activeSelection: { kind: 'session', active: { threadId: 'child', session: { sessionId: 'session', agentTree: [{ threadId: 'root', currentTurnId: 'root-turn', children: [{ threadId: 'child', currentTurnId: turnId, children: [] }] }] } } } } as unknown as ISessionsService);
			await services.invokeFunction(CommandsRegistry.getCommand('sessions.trace.open')!);
			const resource = 'ash-agent-trace:/session?threadId=child' + (turnId ? '&turnId=child-turn' : '');
			assert.deepEqual(opened.map(entry => ({ id: entry.id, content: entry.content, resource: entry.editorInput?.resource.toString() })), [{ id: 'trace', content: 'editor', resource }]);
			assert.equal(stored.get('agentTrace.lastResource'), resource);
		});
	}

	test('keeps the offline import entry when there is no active Session', async () => {
		using services = new InstantiationService();
		const opened: ISessionsEntry[] = [];
		registerHosts(services, opened, new Map());
		services.registerInstance(ISessionsService, { activeSelection: undefined } as unknown as ISessionsService);
		await services.invokeFunction(CommandsRegistry.getCommand('sessions.trace.open')!);
		assert.equal(opened[0].editorInput?.resource.toString(), 'ash-agent-trace:/import');
	});
});

suite('Independent Sessions Trace navigation', () => {
	for (const saved of [undefined, 'ash-agent-trace:/previous?threadId=old-thread&turnId=old-turn', 'https://example.test/invalid']) {
		test(`opens a retained Trace entry instead of the conversation ${String(saved)}`, async () => {
			using services = new InstantiationService();
			const opened: ISessionsEntry[] = [];
			const stored = new Map<string, string>(saved ? [['agentTrace.lastResource', saved]] : []);
			registerHosts(services, opened, stored);
			services.registerInstance(ISessionsService, { activeSelection: { kind: 'session', active: { threadId: 'current', session: { sessionId: 'current-session', agentTree: [{ threadId: 'current', currentTurnId: 'current-turn', children: [] }] } } } } as unknown as ISessionsService);
			const command = CommandsRegistry.getCommand('sessions.open.trace');
			assert.ok(command, 'Trace must have its own Activity Bar entry command');
			await services.invokeFunction(command);
			assert.deepEqual(opened.map(entry => ({ id: entry.id, content: entry.content, sidebar: entry.sidebarContainerId, restore: entry.restoreCommand, resource: entry.editorInput?.resource.toString() })), [{ id: 'trace', content: 'editor', sidebar: 'sessions.navigation.trace', restore: 'sessions.open.trace', resource: saved?.startsWith('ash-agent-trace:') ? saved : 'ash-agent-trace:/current-session?threadId=current&turnId=current-turn' }]);
		});
	}

	test('opens the offline page without reusing a saved live conversation', async () => {
		using services = new InstantiationService();
		const opened: ISessionsEntry[] = [];
		const stored = new Map([['agentTrace.lastResource', 'ash-agent-trace:/previous']]);
		registerHosts(services, opened, stored);
		await services.invokeFunction(CommandsRegistry.getCommand('sessions.trace.import')!);
		assert.equal(opened[0].editorInput?.resource.toString(), 'ash-agent-trace:/import');
		assert.equal(stored.get('agentTrace.lastResource'), 'ash-agent-trace:/import');
	});
});

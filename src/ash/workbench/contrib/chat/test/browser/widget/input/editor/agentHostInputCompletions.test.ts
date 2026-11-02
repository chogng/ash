import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../../../../base/common/async.js';
import { Emitter } from '../../../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../../../base/common/uri.js';
import { Position } from '../../../../../../../../editor/common/core/position.js';
import { createLanguageCompletionInvokeContext, type LanguageCompletionProviderRequest } from '../../../../../../../../editor/common/languages.js';
import { TextModel } from '../../../../../../../../editor/common/model/textModel.js';
import { ILanguageFeaturesService } from '../../../../../../../../editor/common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../../../../../../../editor/common/services/languageFeaturesService.js';
import { LanguageCompletionService } from '../../../../../../../../editor/contrib/suggest/browser/suggest.js';
import { InstantiationService } from '../../../../../../../../platform/instantiation/common/instantiationService.js';
import { IAgentHostInputCompletionService } from '../../../../../../../../platform/agentHost/common/agentService.js';
import type { AgentHostInputCompletionItem } from '../../../../../../../../platform/agentHost/common/agent.js';
import { IWorkspaceContextService, type IWorkspace } from '../../../../../../../../platform/workspace/common/workspace.js';
import { AgentHostInputCompletions, type AgentHostInputCompletionHost } from '../../../../../browser/widget/input/editor/agentHostInputCompletions.js';

suite('AgentHostInputCompletions', () => {
	const resource = URI.parse('vscode-remote://ssh-remote+test/project/src/main.ts');
	const file: AgentHostInputCompletionItem = { label: '#src/main.ts', insertText: '#src/main.ts ', start: 7, end: 17, preselect: true, value: { kind: 'resource', resource, isDirectory: false } };
	function fixture(resources: DisposableStore, complete: IAgentHostInputCompletionService['complete']) {
		const services = resources.add(new InstantiationService());
		const features = resources.add(new LanguageFeaturesService());
		const model = resources.add(new TextModel('Review #src/ma.ts after', { languageId: 'ash-chat-input' }));
		const changes = resources.add(new Emitter<void>());
		const connection = resources.add(new Emitter<void>());
		let workspace: IWorkspace = { id: 'workspace', folders: [{ id: 'authorized-dir', name: 'project', index: 0, uri: URI.parse('vscode-remote://ssh-remote+test/project') }] };
		let lifecycle = new AbortController();
		let enabled = true;
		let triggers = ['/', '$', '@', '#'];
		const accepted: unknown[] = [];
		services.registerInstance(ILanguageFeaturesService, features);
		services.registerInstance(IAgentHostInputCompletionService, { complete, onDidChangeConnection: connection.event, getTriggerCharacters: () => triggers });
		services.registerInstance(IWorkspaceContextService, { getWorkspace: () => workspace, onDidChangeWorkspace: changes.event } as unknown as IWorkspaceContextService);
		const completions = resources.add(services.createInstance(AgentHostInputCompletions, model, {
			currentLifecycle: () => lifecycle.signal, getContext: () => ({ sessionId: 'session', threadId: 'thread' }),
			isEnabled: () => enabled, acceptSkill: skill => { accepted.push(skill); },
			acceptResource: async (resource, directory, range) => { accepted.push([resource, directory, { start: range.start, end: range.end }]); },
		} satisfies AgentHostInputCompletionHost));
		completions.register();
		const provider = features.completionProvider.getProviders('ash-chat-input', createLanguageCompletionInvokeContext())[0]!;
		const request = (): LanguageCompletionProviderRequest => ({ languageId: 'ash-chat-input', resource: model.uri, position: new Position(1, 15), requestId: 1, snapshot: model.createVersionedSnapshot(), context: createLanguageCompletionInvokeContext() });
		return {
			model, provider, request, accepted, completions, features,
			changeTriggers: (value: string[]) => { triggers = value; connection.fire(); },
			disable: () => { enabled = false; }, reconnect: () => connection.fire(),
			switchDraft: () => { lifecycle.abort(); lifecycle = new AbortController(); },
			switchWorkspace: () => { workspace = { ...workspace, id: 'replacement' }; changes.fire(); },
		};
	}

	test('requires the host domain service during production construction', () => {
		using services = new InstantiationService();
		using features = new LanguageFeaturesService();
		using model = new TextModel('', { languageId: 'ash-chat-input' });
		services.registerInstance(ILanguageFeaturesService, features);
		assert.throws(() => services.createInstance(AgentHostInputCompletions, model, { currentLifecycle: () => new AbortController().signal, getContext: () => ({}), isEnabled: () => true, acceptSkill: () => { }, acceptResource: async () => { } }), /Unknown service: agentHostInputCompletionService/u);
	});

	test('sends full context and UTF-16 cursor to the host and admits a remote resource without an early edit', async () => {
		using resources = new DisposableStore();
		const calls: unknown[] = [];
		const value = fixture(resources, async request => { calls.push(request); return [file]; });
		const service = resources.add(new LanguageCompletionService(value.model, value.features.completionProvider, { resource: value.model.uri }));
		await service.request('ash-chat-input', value.request().position, createLanguageCompletionInvokeContext());
		const result = service.results.result?.value;
		assert.deepEqual(calls, [{ text: 'Review #src/ma.ts after', offset: 14, sessionId: 'session', threadId: 'thread', directories: [{ resource: URI.parse('vscode-remote://ssh-remote+test/project'), target: { type: 'workspace', dirId: 'authorized-dir' } }] }]);
		const item = result!.items[0]!;
		assert.equal(item.insertText, '#src/ma.ts');
		assert.deepEqual([item.range.startColumn, item.range.endColumn], [8, 18]);
		await service.executeCompletionCommand('ash-chat-input', item, new AbortController().signal);
		assert.deepEqual(value.accepted, [[resource, false, { start: 7, end: 17 }]]);
	});

	test('adopts the exact pinned skill after the editor inserts the host replacement', async () => {
		using resources = new DisposableStore();
		const skill = { id: { source: 'host', name: 'review' }, version: { type: 'pinnedDigest' as const, digest: 'original' } };
		const value = fixture(resources, async () => [{ label: '$review', insertText: '$review ', start: 0, end: 4, preselect: true, value: { kind: 'skill', skill } }]);
		value.model.setValue('$rev');
		const request = { ...value.request(), position: new Position(1, 5) };
		const result = await value.provider.provideCompletions(request, new AbortController().signal);
		value.model.setValue('$review ');
		await value.provider.executeCompletionCommand!({ ...request, snapshot: value.model.createVersionedSnapshot(), command: result!.items[0]!.command! }, new AbortController().signal);
		assert.deepEqual(value.accepted, [skill]);
	});

	for (const retirement of ['draft', 'workspace', 'connection', 'dispose', 'request'] as const) {
		test(`cancels an outstanding host query on ${retirement} retirement`, async () => {
			using resources = new DisposableStore();
			const pending = new DeferredPromise<readonly AgentHostInputCompletionItem[]>();
			let backendSignal: AbortSignal | undefined;
			const value = fixture(resources, async (_request, signal) => { backendSignal = signal; return pending.p; });
			const cancellation = new AbortController();
			const request = value.provider.provideCompletions(value.request(), cancellation.signal);
			if (retirement === 'draft') value.switchDraft();
			if (retirement === 'workspace') value.switchWorkspace();
			if (retirement === 'connection') value.reconnect();
			if (retirement === 'dispose') value.completions.dispose();
			if (retirement === 'request') cancellation.abort();
			assert.equal(await request, undefined);
			assert.equal(backendSignal?.aborted, true);
			await pending.complete([]);
		});
	}

	test('replaces the editor trigger catalog when initialization or reconnection changes capabilities', () => {
		using resources = new DisposableStore();
		const value = fixture(resources, async () => []);
		const service = resources.add(new LanguageCompletionService(value.model, value.features.completionProvider, { resource: value.model.uri }));
		value.changeTriggers([]);
		assert.equal(service.supportsTriggerCharacter('ash-chat-input', '#'), false);
		value.changeTriggers(['#']);
		assert.equal(service.supportsTriggerCharacter('ash-chat-input', '#'), true);
		assert.equal(service.supportsTriggerCharacter('ash-chat-input', '$'), false);
		assert.equal(value.features.completionProvider.providerCatalog.providers.length, 1);
	});

	test('ignores other inputs and disabled AI and releases registration', async () => {
		using resources = new DisposableStore();
		let queries = 0;
		const value = fixture(resources, async () => { queries++; return []; });
		assert.equal(await value.provider.provideCompletions({ ...value.request(), resource: URI.parse('inmemory:/another-input') }, new AbortController().signal), undefined);
		value.disable();
		assert.equal(await value.provider.provideCompletions(value.request(), new AbortController().signal), undefined);
		assert.equal(queries, 0);
		value.completions.dispose();
		assert.deepEqual(value.features.completionProvider.providerCatalog.providers, []);
	});
});

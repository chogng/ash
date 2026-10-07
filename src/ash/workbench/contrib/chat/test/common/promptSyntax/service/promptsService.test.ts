import assert from 'node:assert/strict';
import { test } from 'mocha';
import { CancellationToken, CancellationTokenSource } from '../../../../../../../base/common/cancellation.js';
import { DeferredPromise } from '../../../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { isCancellationError } from '../../../../../../../base/common/errors.js';
import { URI } from '../../../../../../../base/common/uri.js';
import type { IAppServerSkillApi, SkillCatalog, SkillReference } from '../../../../../../../platform/agentHost/common/appServerApi.js';
import { PromptsService } from '../../../../common/promptSyntax/service/promptsServiceImpl.js';
import { IPromptsService } from '../../../../common/promptSyntax/service/promptsService.js';
import { CONFIGURE_SKILLS_ACTION_ID, registerSkillActions } from '../../../../browser/promptSyntax/skillActions.js';
import { CommandsRegistry } from '../../../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../../../platform/instantiation/common/instantiationService.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem, type IQuickPickSeparator } from '../../../../../../../platform/quickinput/common/quickInput.js';
import { IChatSessionNavigationService } from '../../../../../../services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../../../../services/editor/common/editorService.js';
import { IPreferencesService } from '../../../../../../services/preferences/common/preferences.js';
import { INotificationService } from '../../../../../../../platform/notification/common/notification.js';
import type { IResourceEditorInput } from '../../../../../../common/editor.js';
import { builtinLanguagePackCatalogs } from '../../../../../../services/localization/common/localizationCatalogs.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../../../nls.js';

const id = { source: 'user:review-source', name: 'review' };
const digest = `sha256:${'a'.repeat(64)}`;
const catalog: SkillCatalog = { generation: 3, skills: [{ id, contentDigest: digest, description: 'Review changes', enabled: true, compatible: true }] };
const instructions = '---\r\nname: review\r\n---\r\n# Review\r\nKeep the exact file.\r\n';

class Backend extends Disposable implements IAppServerSkillApi {
	readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeSkills = this.changed.event;
	readonly calls: unknown[] = [];
	public list = async (reload: 'cached' | 'refresh', sessionId?: string): Promise<SkillCatalog> => { this.calls.push(['list', reload, sessionId]); return catalog; };
	public read = async (sessionId?: string) => { this.calls.push(['read', sessionId]); return { revision: 7, catalog, diagnostics: [] }; };
	public setEnabled = async (skillId: typeof id, enabled: boolean, revision: number, sessionId?: string) => { this.calls.push(['set', skillId, enabled, revision, sessionId]); };
	public readInstructions = async (reference: SkillReference, signal: AbortSignal, sessionId?: string) => { this.calls.push(['body', reference, sessionId, signal.aborted]); return instructions; };
}

test('Prompt discovery is metadata-only and reading pins source, digest and Session', async () => {
	using backend = new Backend();
	using prompts = new PromptsService(backend);
	const [first] = await prompts.findAgentSkills(CancellationToken.None, 'first');
	const [second] = await prompts.findAgentSkills(CancellationToken.None, 'second');
	assert.notEqual(first.uri.toString(), second.uri.toString());
	assert.equal(first.uri.scheme, 'private');
	assert.deepEqual(backend.calls, [['list', 'cached', 'first'], ['list', 'cached', 'second']]);
	const parsed = await prompts.parseNew(first.uri);
	assert.deepEqual({ content: parsed.content, body: parsed.body, uri: parsed.uri }, { content: instructions, body: '# Review\nKeep the exact file.\n', uri: first.uri });
	assert.deepEqual(backend.calls.at(-1), ['body', { id, version: { type: 'pinnedDigest', digest } }, 'first', false]);
});

test('Prompt management uses the same discovered URIs and backend revision authority', async () => {
	using backend = new Backend();
	using prompts = new PromptsService(backend);
	const snapshot = await prompts.readSkillManagement('first');
	const [skill] = await prompts.findAgentSkills(CancellationToken.None, 'first');
	assert.equal(snapshot.catalog.skills[0].uri.toString(), skill.uri.toString());
	await prompts.setSkillEnablement(id, false, snapshot.revision, 'first');
	assert.deepEqual(backend.calls.at(-1), ['set', id, false, 7, 'first']);
});

test('Prompt URIs from another window or a changed catalog cannot open instructions', async () => {
	using backend = new Backend();
	using prompts = new PromptsService(backend);
	using otherWindow = new PromptsService(backend);
	const [skill] = await prompts.findAgentSkills(CancellationToken.None, 'first');
	await assert.rejects(otherWindow.parseNew(skill.uri), /not discovered/u);
	await assert.rejects(prompts.parseNew(URI.file('/private/SKILL.md')), /not discovered/u);
	backend.changed.fire();
	await assert.rejects(prompts.parseNew(skill.uri), /not discovered/u);
	assert.equal(backend.calls.filter(call => Array.isArray(call) && call[0] === 'body').length, 0);
});

test('Prompt discovery discards a reply completed after catalog invalidation', async () => {
	using backend = new Backend();
	using prompts = new PromptsService(backend);
	const pending = new DeferredPromise<SkillCatalog>();
	backend.list = () => pending.p;
	const discovery = prompts.findAgentSkills(CancellationToken.None, 'first');
	backend.changed.fire();
	await pending.complete(catalog);
	await assert.rejects(discovery, isCancellationError);
});

for (const reason of ['token', 'catalog', 'window'] as const) {
	test(`Prompt body reading aborts and rejects a late reply after ${reason} cancellation`, async () => {
		using backend = new Backend();
		using prompts = new PromptsService(backend);
		using cancellation = new CancellationTokenSource();
		const pending = new DeferredPromise<string>();
		let signal: AbortSignal | undefined;
		backend.readInstructions = (_reference, current) => { signal = current; return pending.p; };
		const [skill] = await prompts.findAgentSkills(CancellationToken.None, 'first');
		const reading = prompts.parseNew(skill.uri, cancellation.token);
		if (reason === 'token') cancellation.cancel();
		if (reason === 'catalog') backend.changed.fire();
		if (reason === 'window') prompts.dispose();
		assert.equal(signal?.aborted, true);
		await pending.complete(instructions);
		await assert.rejects(reading, isCancellationError);
		if (reason === 'window') assert.equal(backend.changed.hasListeners(), false);
	});
}

class Picker extends Disposable implements IQuickPick<IQuickPickItem> {
	readonly accepted = this._register(new Emitter<IQuickPickItem>());
	readonly hidden = this._register(new Emitter<void>());
	readonly onDidAccept = this.accepted.event;
	readonly onDidHide = this.hidden.event;
	readonly onDidChangeValue = Event.None;
	readonly onDidBlur = Event.None;
	readonly onDidTriggerItemButton = Event.None;
	private currentItems: readonly (IQuickPickItem | IQuickPickSeparator)[] = [];
	readonly loaded = new DeferredPromise<void>();
	get items() { return this.currentItems; }
	set items(items: readonly (IQuickPickItem | IQuickPickSeparator)[]) {
		this.currentItems = items;
		if (items.some(item => 'label' in item && item.label === 'review')) void this.loaded.complete();
	}
	ariaLabel = '';
	placeholder = '';
	value = '';
	valueSelection = { start: 0, end: 0 };
	filterValue = (value: string) => value;
	busy = false;
	show(): void { }
	hide(): void { this.hidden.fire(); }
}

registerSkillActions();

for (const locale of ['en', 'zh-CN']) {
	test(`Configure Skills opens the selected readonly document with ${locale} picker labels`, async () => {
		setNlsMessages(locale, builtinLanguagePackCatalogs.find(catalog => catalog.locale === locale)!.bundles);
		try {
			using backend = new Backend();
			using prompts = new PromptsService(backend);
			using picker = new Picker();
			using services = new InstantiationService();
			const opened: IResourceEditorInput[] = [];
			services.registerInstance(IPromptsService, prompts);
			services.registerInstance(IQuickInputService, { createQuickPick: () => picker } as unknown as IQuickInputService);
			services.registerInstance(IChatSessionNavigationService, { getActiveConversation: () => ({ sessionId: 'first', threadId: 'thread' }) } as IChatSessionNavigationService);
			services.registerInstance(IEditorService, { openEditor: async input => { opened.push(input); } } as IEditorService);
			services.registerInstance(IPreferencesService, { openSettings: async () => { assert.fail('Reading a file must not open Settings'); } } as unknown as IPreferencesService);
			services.registerInstance(INotificationService, { error: () => assert.fail('File reading must succeed') } as unknown as INotificationService);
			const running = services.invokeFunction(CommandsRegistry.getCommand(CONFIGURE_SKILLS_ACTION_ID)!);
			await picker.loaded.p;
			assert.equal(picker.ariaLabel, locale === 'en' ? 'Select a skill file to open' : '选择要打开的技能文件');
			assert.equal(picker.items.at(-1)?.label, locale === 'en' ? 'Manage skill enablement…' : '管理技能启停…');
			picker.accepted.fire(picker.items[0] as IQuickPickItem);
			await running;
			assert.deepEqual(opened.map(input => ({ text: input.initialText, label: input.label, readOnly: input.readOnly })), [{ text: instructions, label: 'review/SKILL.md', readOnly: true }]);
		} finally { resetNlsResolver(); }
	});
}

for (const reason of ['dismissed', 'session changed'] as const) {
	test(`Configure Skills discards the loaded file after the picker is ${reason}`, async () => {
		using backend = new Backend();
		using prompts = new PromptsService(backend);
		using picker = new Picker();
		using services = new InstantiationService();
		const pending = new DeferredPromise<string>();
		const started = new DeferredPromise<AbortSignal>();
		backend.readInstructions = (_reference, signal) => { void started.complete(signal); return pending.p; };
		let sessionId = 'first';
		services.registerInstance(IPromptsService, prompts);
		services.registerInstance(IQuickInputService, { createQuickPick: () => picker } as unknown as IQuickInputService);
		services.registerInstance(IChatSessionNavigationService, { getActiveConversation: () => ({ sessionId, threadId: 'thread' }) } as IChatSessionNavigationService);
		services.registerInstance(IEditorService, { openEditor: async () => assert.fail('Retired selection must not open an editor') } as unknown as IEditorService);
		services.registerInstance(IPreferencesService, {} as IPreferencesService);
		services.registerInstance(INotificationService, { error: () => assert.fail('Retired selection must not show an error') } as unknown as INotificationService);
		const running = services.invokeFunction(CommandsRegistry.getCommand(CONFIGURE_SKILLS_ACTION_ID)!);
		await picker.loaded.p;
		picker.accepted.fire(picker.items[0] as IQuickPickItem);
		const signal = await started.p;
		if (reason === 'dismissed') picker.hide();
		else sessionId = 'second';
		assert.equal(signal.aborted, reason === 'dismissed');
		await pending.complete(instructions);
		await running;
	});
}

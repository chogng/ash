import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import '../../../chat/browser/chat.shared.contribution.js';
import assert from 'node:assert/strict';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { suite, test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import type { AgentReviewTarget, SessionResult } from '../../../../../platform/agentHost/common/agent.js';
import { IAgentSessionService } from '../../../../../platform/agentHost/common/agentService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { IChatService, type StartReviewOptions } from '../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { ISCMViewService, type ISCMProvider } from '../../common/scm.js';
import type { ISCMHistoryItemRef } from '../../common/history.js';
import { ScmAgentReviewViewPane } from '../../browser/scmAgentReviewViewPane.js';

function fixture() {
	const resources = new DisposableStore();
	const services = resources.add(new InstantiationService());
	const configuration = resources.add(new InMemoryConfigurationService());
	const quickInput = resources.add(new TestQuickInputService({ container: browserEnvironment.window.document.body }));
	const root = browserEnvironment.window.document.createElement('div');
	browserEnvironment.window.document.body.append(root);
	let menu: IContextMenuDelegate;
	const requests: StartReviewOptions[] = [];
	const operations: string[] = [];
	const errors: unknown[] = [];
	let creationCount = 0;
	let fail = false;
	let focus: string | undefined;
	let references: Promise<readonly ISCMHistoryItemRef[]> = Promise.resolve([]);
	const provider = {
		rootUri: URI.file('/workspace/repository'), label: 'Git', activeRepositoryName: 'repository',
		historyProvider: { provideHistoryItemRefs: () => references },
	} as unknown as ISCMProvider;
	services.registerInstance(ISCMViewService, { activeRepository: { ...Disposable.None, id: 'repository', provider }, onDidChangeActiveRepository: Event.None, selectRepository() { } });
	services.registerInstance(IContextMenuService, { showContextMenu(value) { menu = value as IContextMenuDelegate; } } as IContextMenuService);
	services.registerInstance(IQuickInputService, quickInput);
	services.registerInstance(IAgentSessionService, {
		async create(params: Parameters<IAgentSessionService['create']>[0]) {
			creationCount++;
			assert.deepEqual(params.executionTarget, { type: 'local', root: '/workspace/repository' });
			if (fail) throw new Error('Controlled review failure');
			return {
				session: { sessionId: 'review', title: params.title, status: 'active', manager: { status: 'idle', statusChangedAtUnixMs: 0 }, threads: [{ threadId: 'thread', title: 'Review', status: 'active' }] },
				agentTree: { roots: [] },
			} satisfies SessionResult;
		},
	} as unknown as IAgentSessionService);
	services.registerInstance(IChatSessionNavigationService, { async openConversation() { operations.push('open'); } } as unknown as IChatSessionNavigationService);
	services.registerInstance(IChatService, {
		async readThread() { return { thread: { sequence: 7 } }; },
		async startReview(options: StartReviewOptions) { operations.push('review'); requests.push(options); },
	} as unknown as IChatService);
	services.registerInstance(INotificationService, { error(error: unknown) { errors.push(error); } } as unknown as INotificationService);
	services.registerInstance(IConfigurationService, configuration);
	const pane = resources.add(services.createInstance(ScmAgentReviewViewPane, root, { id: 'ash.gitAgentReview', title: 'Agent Review' }));
	const primary = pane.element.querySelector<HTMLButtonElement>('.ash-scm-find-issues > button:first-child')!;
	const dropdown = pane.element.querySelector<HTMLButtonElement>('.ash-scm-find-issues > button:last-child')!;
	return {
		pane, primary, dropdown, requests, operations, errors, services, quickInput, configuration,
		get creationCount() { return creationCount; },
		setFail(value: boolean) { fail = value; },
		setFocus(value: string | undefined) { focus = value; quickInput.input = async () => focus; },
		setReferences(value: Promise<readonly ISCMHistoryItemRef[]>) { references = value; },
		menu() { dropdown.click(); return menu; },
		async choose(id: string) {
			const delegate = this.menu();
			const action = delegate.getActions().find(item => item.id === `scm.review.${id}`)!;
			delegate.onHide?.(false);
			await action.run();
		},
		async clickPrimary() {
			const complete = new Promise<void>(resolve => {
				const observer = new browserEnvironment.window.MutationObserver(() => {
					if (!primary.disabled) { observer.disconnect(); resolve(); }
				});
				observer.observe(pane.element, { attributes: true, subtree: true });
			});
			primary.click();
			await complete;
		},
		dispose() { resources.dispose(); root.remove(); },
		[Symbol.dispose]() { this.dispose(); },
	};
}

suite('SCM Agent Review', () => {
	test('menu reviews one scope immediately and primary always reviews current changes', async () => {
		using context = fixture();
		assert.equal(context.primary.textContent, 'Find Issues');
		assert.equal(context.pane.element.querySelector<HTMLElement>('.ash-scm-empty')?.hidden, true);
		assert.ok(context.primary.classList.contains('label-centered'));
		assert.equal(context.dropdown.getAttribute('aria-haspopup'), 'menu');
		const menu = context.menu();
		assert.deepEqual(menu.getActions().filter(item => item.label).map(item => item.label), [
			'Review Current Changes', 'Review Staged Changes Only', 'Review Branch Changes...', 'Custom Review...',
		]);
		menu.onHide?.(false);
		await context.choose('staged');
		await context.clickPrimary();
		assert.deepEqual(context.requests, [
			{ sessionId: 'review', threadId: 'thread', expectedSequence: 7, target: { type: 'stagedChanges' } },
			{ sessionId: 'review', threadId: 'thread', expectedSequence: 7, target: { type: 'uncommittedChanges' } },
		]);
		assert.deepEqual(context.operations, ['open', 'review', 'open', 'review']);
	});

	test('branch input starts the requested comparison and cancellation starts nothing', async () => {
		using context = fixture();
		context.setFocus('  origin/main  ');
		await context.choose('branch');
		assert.deepEqual(context.requests[0]?.target, { type: 'baseBranch', branch: 'origin/main' });
		context.setFocus(undefined);
		await context.choose('branch');
		assert.equal(context.creationCount, 1);
	});

	test('loaded branches keep their picker alive until selection and preserve the exact reference', async () => {
		using context = fixture();
		const references = new DeferredPromise<readonly ISCMHistoryItemRef[]>();
		context.setReferences(references.p);
		const shown = new Promise<void>(resolve => Event.once(context.quickInput.onShow)(() => resolve()));
		const choosing = context.choose('branch');
		await shown;
		const picker = context.quickInput.currentQuickInput as IQuickPick<IQuickPickItem & { readonly branch: string; }>;
		await references.complete([{ id: 'refs/remotes/origin/main', name: 'origin/main', category: 'remoteBranch' }, { id: 'refs/tags/v1', name: 'v1', category: 'tag' }]);
		await nextEventLoopTurn();
		assert.equal(picker.items.length, 1);
		assert.equal(context.quickInput.currentQuickInput, picker);
		const item = picker.items[0] as IQuickPickItem & { readonly branch: string; };
		picker.selectedItems = [item];
		await picker.accept();
		await choosing;
		assert.deepEqual(context.requests[0]?.target, { type: 'baseBranch', branch: 'refs/remotes/origin/main' });
	});

	test('cancelling a pending branch load starts nothing', async () => {
		using context = fixture();
		const references = new DeferredPromise<readonly ISCMHistoryItemRef[]>();
		context.setReferences(references.p);
		const shown = new Promise<void>(resolve => Event.once(context.quickInput.onShow)(() => resolve()));
		const choosing = context.choose('branch');
		await shown;
		await context.quickInput.cancel();
		await choosing;
		await references.complete([]);
		assert.equal(context.creationCount, 0);
	});

	test('custom focus reviews current changes without changing the primary default', async () => {
		using context = fixture();
		context.setFocus('  Check concurrency  ');
		await context.choose('custom');
		const target = context.requests[0]!.target as Extract<AgentReviewTarget, { type: 'custom'; }>;
		assert.equal(target.instructions, 'Review all staged, unstaged and untracked changes in the current repository. Do not modify files or the index. Additional review focus: Check concurrency');
		assert.equal(context.primary.textContent, 'Find Issues');
		context.setFocus(undefined);
		await context.choose('custom');
		assert.equal(context.creationCount, 1);
	});

	test('a failed review restores the button for retry and disabled AI blocks new work', async () => {
		using context = fixture();
		context.setFail(true);
		await context.choose('current');
		assert.match(String(context.errors[0]), /Controlled review failure/);
		assert.equal(context.primary.disabled, false);
		context.setFail(false);
		await context.choose('current');
		await context.configuration.updateValue('chat.disableAIFeatures', true);
		assert.equal(context.primary.disabled, true);
		assert.equal(context.dropdown.disabled, true);
		context.primary.click();
		assert.equal(context.creationCount, 2);
	});

	test('Chinese labels and accessible names use the client language pack', () => {
		const catalog = productLanguagePackCatalogs.find(item => item.locale === 'zh-CN')!;
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, parameters));
		try {
			using context = fixture();
			assert.equal(context.primary.textContent, '查找问题');
			assert.equal(context.dropdown.getAttribute('aria-label'), '选择审查范围');
			const menu = context.menu();
			assert.deepEqual(menu.getActions().filter(item => item.label).map(item => item.label), ['审查当前改动', '仅审查已暂存改动', '审查分支改动…', '自定义审查…']);
			menu.onHide?.(false);
		} finally { resetNlsResolver(); }
	});

	test('creation requires the registered services', () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(ScmAgentReviewViewPane, browserEnvironment.window.document.body, { id: 'review', title: 'Review' }), /Unknown service: scmView/);
	});
});

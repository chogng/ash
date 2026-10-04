import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import type { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IHoverService, type IManagedHover } from '../../../../../platform/hover/browser/hoverService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { SCMRepositoriesViewPane, REPOSITORIES_VIEW_PANE_ID } from '../../browser/scmRepositoriesViewPane.js';
import { SCMViewService } from '../../browser/scmViewService.js';
import { ISCMService, ISCMViewService, type ISCMProvider, type ISCMResourceGroup } from '../../common/scm.js';
import { SCMService } from '../../common/scmService.js';

function provider(id: string, path: string, activate: () => Promise<void>): ISCMProvider {
	return {
		id, providerId: 'git', label: 'ash', rootUri: URI.file(path), groups: [], onDidChangeResources: Event.None,
		input: { value: '', placeholder: '', enabled: false, canAccept: false, buttonLabel: '', buttonTooltip: '', accept: async () => undefined },
		activeRepositoryName: id, statusBarCommands: [], statusMessage: '', isBusy: false,
		refresh: async () => {}, activate,
	};
}

function fixture(): DisposableStore & { scm: SCMService; views: SCMViewService; services: InstantiationService; container: HTMLElement; browser: JSDOM } {
	const resources = new DisposableStore();
	const browser = browserEnvironment;
	const scm = resources.add(new SCMService());
	const views = resources.add(new SCMViewService(scm));
	const services = resources.add(new InstantiationService());
	const configuration = resources.add(new InMemoryConfigurationService());
	const container = browser.window.document.createElement('div');
	browser.window.document.body.append(container);
	resources.add(toDisposable(() => container.remove()));
	services.registerInstance(ISCMService, scm);
	services.registerInstance(ISCMViewService, views);
	services.registerInstance(IConfigurationService, configuration);
	const hover = (): IManagedHover => ({ visible: false, show() {}, hide() {}, update() {}, ...toDisposable(() => {}) });
	services.registerInstance(IHoverService, { setupDelayedHover: hover, setupHover: hover, showHover: hover, hideHover() {} });
	return Object.assign(resources, { scm, views, services, container, browser });
}

suite('SCMRepositoriesViewPane', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('distinguishes same-name worktrees, preserves focus through status updates and localizes rows', async () => {
		const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		try {
			using environment = fixture();
			using changes = new Emitter<void>();
			let branch = 'topic';
			let groups: readonly ISCMResourceGroup[] = [];
			using main = environment.scm.registerSCMProvider(provider('main', '/desktop/ash', async () => {}));
			using worktree = environment.scm.registerSCMProvider({
				...provider('topic', '/desktop/ash/.delta/worktrees/review/ash', async () => {}),
				onDidChangeResources: changes.event,
				get activeRepositoryName() { return branch; },
				get groups() { return groups; },
			});
			using pane = environment.services.createInstance(SCMRepositoriesViewPane, environment.container, { id: REPOSITORIES_VIEW_PANE_ID, title: '仓库' });
			environment.container.append(pane.element);
			pane.setVisible(true);
			const list = pane.element.querySelector<HTMLElement>('[role="listbox"]')!;
			const rows = list.querySelectorAll<HTMLElement>('[role="option"]');
			assert.equal(list.getAttribute('aria-label'), '源代码管理仓库');
			assert.deepEqual([...rows].map(row => row.querySelector('.ash-scm-repository-path')?.textContent), ['desktop/ash', 'review/ash']);
			pane.focus();
			list.dispatchEvent(new environment.browser.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
			assert.equal(environment.views.activeRepository, main);
			const focusedId = list.getAttribute('aria-activedescendant');
			branch = 'review-topic';
			const resource = { sourceUri: URI.file('/desktop/ash/.delta/worktrees/review/ash/file.ts'), path: 'file.ts', decorations: { badge: 'M', tooltip: '', kind: 'modified' }, openLabel: '', actions: [], open: async () => {} };
			groups = [{ id: 'staged', label: '', resources: [resource], actions: [] }, { id: 'changes', label: '', resources: [resource], actions: [] }];
			changes.fire();
			assert.equal(list.getAttribute('aria-activedescendant'), focusedId);
			assert.equal(environment.browser.window.document.activeElement, list);
			assert.equal(rows[1].querySelector('.ash-count-badge')?.textContent, '1');
			assert.ok(rows[1].getAttribute('aria-label')?.includes('review-topic，1 个已更改文件'));
			list.dispatchEvent(new environment.browser.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
			await Promise.resolve();
			assert.equal(environment.views.activeRepository, worktree);
			assert.equal(rows[1].getAttribute('aria-selected'), 'true');
			environment.views.selectRepository(main.id);
			assert.equal(rows[0].getAttribute('aria-selected'), 'true');
			worktree.dispose();
			assert.equal(list.querySelectorAll('[role="option"]').length, 1);
			assert.equal(rows[0].querySelector('.ash-scm-repository-path')?.textContent, '');
		} finally {
			resetNlsResolver();
		}
	});

	test('keeps the accepted repository after activation fails and ignores activation completed after removal', async () => {
		using environment = fixture();
		using main = environment.scm.registerSCMProvider(provider('main', '/desktop/ash', async () => {}));
		const activation = new DeferredPromise<void>();
		using topic = environment.scm.registerSCMProvider(provider('topic', '/worktrees/ash', () => activation.p));
		using pane = environment.services.createInstance(SCMRepositoriesViewPane, environment.container, { id: REPOSITORIES_VIEW_PANE_ID, title: 'Repositories' });
		pane.setVisible(true);
		const list = pane.element.querySelector<HTMLElement>('[role="listbox"]')!;
		list.querySelectorAll<HTMLElement>('[role="option"]')[1].click();
		assert.equal(list.getAttribute('aria-busy'), 'true');
		await activation.error(new Error('Repository unavailable'));
		await Promise.resolve();
		assert.equal(environment.views.activeRepository, main);
		assert.equal(list.getAttribute('aria-busy'), 'false');
		assert.equal(pane.element.querySelector('[role="status"]')?.textContent, 'Could not select repository: Repository unavailable');

		const removedActivation = new DeferredPromise<void>();
		using removed = environment.scm.registerSCMProvider(provider('removed', '/other/ash', () => removedActivation.p));
		list.querySelectorAll<HTMLElement>('[role="option"]')[2].click();
		removed.dispose();
		await removedActivation.complete();
		await Promise.resolve();
		assert.equal(environment.views.activeRepository, main);
		assert.equal(list.getAttribute('aria-busy'), 'false');
	});
});

import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize, resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { AccessibilityService } from '../../../../../platform/accessibility/browser/accessibilityService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { SideBySideEditor } from '../../../../browser/parts/editor/sideBySideEditor.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import type { IEditorPane, IEditorPaneScrollPosition, IEditorPaneWithScrolling } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IStatusbarService, StatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { createTestEditorServices } from '../../../../test/common/testEditorServices.js';
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import { SyncScroll } from '../../browser/scrollLocking.js';
import '../../browser/scrollLocking.contribution.js';

class ScrollPane extends EditorPane implements IEditorPaneWithScrolling {
	readonly id = 'test.scrollPane';
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeScroll = this.changed.event;
	writes = 0;
	constructor(private position: IEditorPaneScrollPosition, private readonly limit: number, @IThemeService theme: IThemeService, @IStorageService storage: IStorageService) { super('test.scrollPane', theme, storage); }
	getScrollPosition(): IEditorPaneScrollPosition { return this.position; }
	setScrollPosition(position: IEditorPaneScrollPosition): void {
		this.writes++;
		this.position = { scrollTop: Math.max(0, Math.min(this.limit, position.scrollTop)), ...(this.position.scrollLeft === undefined ? {} : { scrollLeft: Math.max(0, position.scrollLeft ?? this.position.scrollLeft) }) };
		this.changed.fire();
	}
	focus(): void { }
	async setInput(): Promise<void> { }
	clearInput(): void { }
	layout(): void { }
}

function pane(resources: DisposableStore, position: IEditorPaneScrollPosition, limit = 1000): ScrollPane {
	const services = resources.add(createTestEditorServices());
	return resources.add(services.createInstance(ScrollPane, position, limit));
}

function setup(resources: DisposableStore, initial: readonly IEditorPane[]) {
	const services = resources.add(createTestEditorServices());
	const changed = resources.add(new Emitter<void>());
	let panes = initial;
	const editors: IEditorService = {
		...emptyEditorServiceState,
		onDidVisibleEditorsChange: changed.event,
		get visibleEditorPanes() { return panes; },
		async openEditor() { },
		focusActiveEditor() { },
	};
	services.registerInstance(IEditorService, editors);
	const statusbar = resources.add(new StatusbarService());
	services.registerInstance(IStatusbarService, statusbar);
	services.registerInstance(IAccessibilityService, resources.add(new AccessibilityService({ root: document.body, contextKeyService: services.get(IContextKeyService), configurationService: services.get(IConfigurationService) })));
	const commands = resources.add(new CommandService(services));
	const host = resources.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, [SyncScroll.ID]));
	host.advance(WorkbenchPhase.AfterRestored);
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right).length, 0);
	host.advance(WorkbenchPhase.Eventually);
	return { services, commands, statusbar, host, replace(next: readonly IEditorPane[]) { panes = next; changed.fire(); } };
}

test('locked scrolling command preserves both offsets, ignores recursive writes and releases listeners', async () => {
	using resources = new DisposableStore();
	const a = pane(resources, { scrollTop: 100, scrollLeft: 20 });
	const b = pane(resources, { scrollTop: 300, scrollLeft: 80 });
	const { commands, statusbar } = setup(resources, [a, b]);
	await commands.executeCommand('workbench.action.toggleLockedScrolling');
	assert.deepEqual([a.getScrollPosition(), b.getScrollPosition()], [{ scrollTop: 100, scrollLeft: 20 }, { scrollTop: 300, scrollLeft: 80 }]);
	a.setScrollPosition({ scrollTop: 150, scrollLeft: 35 });
	assert.deepEqual(b.getScrollPosition(), { scrollTop: 350, scrollLeft: 95 });
	assert.equal(a.writes, 1);
	assert.equal(b.writes, 1);
	b.setScrollPosition({ scrollTop: 320, scrollLeft: 90 });
	assert.deepEqual(a.getScrollPosition(), { scrollTop: 120, scrollLeft: 30 });
	const entries = statusbar.getEntries(StatusbarAlignment.Right);
	assert.equal(entries.length, 1);
	entries[0].entry.run!();
	a.setScrollPosition({ scrollTop: 200, scrollLeft: 40 });
	assert.deepEqual(b.getScrollPosition(), { scrollTop: 320, scrollLeft: 90 });
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Right), []);
});

test('locked scrolling keeps its baseline when a target clamps and rebuilds it for visible panes', async () => {
	using resources = new DisposableStore();
	const a = pane(resources, { scrollTop: 100, scrollLeft: 20 });
	const b = pane(resources, { scrollTop: 300 }, 340);
	const c = pane(resources, { scrollTop: 600, scrollLeft: 70 });
	const { commands, replace, host } = setup(resources, [a, b]);
	await commands.executeCommand('workbench.action.toggleLockedScrolling');
	a.setScrollPosition({ scrollTop: 180, scrollLeft: 50 });
	assert.deepEqual(b.getScrollPosition(), { scrollTop: 340 });
	a.setScrollPosition({ scrollTop: 110, scrollLeft: 25 });
	assert.deepEqual(b.getScrollPosition(), { scrollTop: 310 });
	replace([a, c]);
	b.setScrollPosition({ scrollTop: 200 });
	assert.equal(a.getScrollPosition().scrollTop, 110);
	a.setScrollPosition({ scrollTop: 160, scrollLeft: 30 });
	assert.deepEqual(c.getScrollPosition(), { scrollTop: 650, scrollLeft: 75 });
	host.dispose();
	a.setScrollPosition({ scrollTop: 200 });
	assert.equal(c.getScrollPosition().scrollTop, 650);
});

test('locked scrolling expands side-by-side panes and deduplicates visible targets', async () => {
	using resources = new DisposableStore();
	const a = pane(resources, { scrollTop: 10 });
	const { services, commands, replace } = setup(resources, [a]);
	const primary = services.createInstance(ScrollPane, { scrollTop: 200 }, 1000);
	const secondary = services.createInstance(ScrollPane, { scrollTop: 400 }, 1000);
	const pair = resources.add(services.get(IInstantiationService).createInstance(SideBySideEditor, 'test.pair', secondary, primary));
	replace([a, pair, primary]);
	await commands.executeCommand('workbench.action.toggleLockedScrolling');
	a.setScrollPosition({ scrollTop: 40 });
	assert.equal(primary.getScrollPosition().scrollTop, 230);
	assert.equal(secondary.getScrollPosition().scrollTop, 430);
	assert.equal(primary.writes, 1);
});

test('locked scrolling commands resolve the invoking window and localize the status in Chinese', async () => {
	using first = new DisposableStore();
	using second = new DisposableStore();
	const a = pane(first, { scrollTop: 10 });
	const b = pane(second, { scrollTop: 20 });
	const left = setup(first, [a]);
	const right = setup(second, [b]);
	const catalog = productLanguagePackCatalogs.find(item => item.locale === 'zh-CN');
	assert.ok(catalog);
	setNlsMessages(catalog.locale, catalog.bundles);
	try {
		await left.commands.executeCommand('workbench.action.toggleLockedScrolling');
		assert.equal(left.statusbar.getEntries(StatusbarAlignment.Right)[0].entry.ariaLabel, '已启用联动滚动');
		assert.equal(right.statusbar.getEntries(StatusbarAlignment.Right).length, 0);
		assert.match(localize('scrollLocking.help', ''), /释放快捷键/);
		await right.commands.executeCommand('workbench.action.toggleLockedScrolling');
		first.dispose();
		assert.equal(right.statusbar.getEntries(StatusbarAlignment.Right).length, 1);
	} finally { resetNlsResolver(); }
});

test('locked scrolling creation rejects missing service registrations', () => {
	using resources = new DisposableStore();
	const services = resources.add(createTestEditorServices());
	assert.throws(() => services.createInstance(SyncScroll), /Unknown service: editorService/);
});

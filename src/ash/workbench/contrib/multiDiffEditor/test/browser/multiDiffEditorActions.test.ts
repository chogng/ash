import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { createTestComponentServices } from '../../../../test/common/testEditorServices.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IEditorPart as IEditorPartShape } from '../../../../browser/parts/editor/editorPart.js';
import { ActiveEditorContext } from '../../../../common/contextkeys.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import { commandActionLabel } from '../../../../../platform/action/common/action.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';

test('MultiDiff Action2 contributions use active-editor context and route to the active pane', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	const installedGlobals = installDomGlobals(browser);
	try {
		const { IEditorPart } = await import('../../../../browser/parts/editor/editorPart.js');
		const {
			MultiDiffCollapseAllAction,
			MultiDiffCollapseAllCommandId,
			MultiDiffExpandAllAction,
			MultiDiffExpandAllCommandId,
			MultiDiffToggleCollapseAllAction,
			MultiDiffToggleCollapseAllCommandId,
			MultiDiffGoToFileAction,
			MultiDiffGoToFileCommandId,
			MultiDiffGoToNextChangeAction,
			MultiDiffGoToNextChangeCommandId,
			MultiDiffGoToPreviousChangeAction,
			MultiDiffGoToPreviousChangeCommandId,
			MultiDiffToggleCollapseUnchangedRegionsAction,
			MultiDiffToggleCollapseUnchangedRegionsCommandId,
		} = await import('../../browser/multiDiffEditorActions.js');
		const { MULTI_DIFF_EDITOR_ID } = await import('../../browser/multiDiffEditorInput.js');
		const { MultiDiffEditor } = await import('../../browser/multiDiffEditor.js');
		class TrackingMultiDiffEditor extends MultiDiffEditor {
			public readonly calls: string[] = [];

			constructor(@IInstantiationService instantiationService: IInstantiationService, @IThemeService themes: IThemeService, @IStorageService storage: IStorageService) {
				super(
					{
						modelService: {
							acquire: async () => {
								throw new Error('Not used');
							},
							dispose() {},
							[Symbol.dispose]() {},
						},
						createComputationService: () => ({
							computeDiff: async () => {
								throw new Error('Not used');
							},
							onDidChange: Event.None,
							dispose() {},
							[Symbol.dispose]() {},
						}),
					},
					instantiationService,
					themes,
					storage,
				);
			}

			public override nextChange(): undefined {
				this.calls.push('next');
				return undefined;
			}

			public override previousChange(): undefined {
				this.calls.push('previous');
				return undefined;
			}

			public override collapseAll(): void {
				this.calls.push('collapse');
			}

			public override expandAll(): void {
				this.calls.push('expand');
			}

			public override toggleCollapseAll(): void {
				this.calls.push('toggleCollapse');
			}

			public override async toggleCollapseUnchangedRegions(): Promise<void> {
				this.calls.push('toggleUnchanged');
			}
		}

		using registrations = new DisposableStore();
		registrations.add(registerAction2(MultiDiffGoToNextChangeAction));
		registrations.add(registerAction2(MultiDiffGoToPreviousChangeAction));
		registrations.add(registerAction2(MultiDiffCollapseAllAction));
		registrations.add(registerAction2(MultiDiffExpandAllAction));
		registrations.add(registerAction2(MultiDiffToggleCollapseAllAction));
		registrations.add(registerAction2(MultiDiffGoToFileAction));
		registrations.add(registerAction2(MultiDiffToggleCollapseUnchangedRegionsAction));
		const services = registrations.add(createTestComponentServices(undefined, undefined, browser.window.document));
		const pane = services.createInstance(TrackingMultiDiffEditor);
		registrations.add(pane);
		services.registerInstance(IEditorPart, { activePane: pane } as unknown as IEditorPartShape);
		const openedInputs: IResourceEditorInput[] = [];
		services.registerInstance(IEditorService, {
			...emptyEditorServiceState,
			async openEditor(input) {
				openedInputs.push(input);
			},
			focusActiveEditor() {},
		});
		using commands = new CommandService(services);
		using contexts = new ContextKeyService();
		const menus = new MenuService(commands, contexts);

		assert.deepEqual(menus.getMenuActions(MenuId.EditorTitle), []);
		contexts.setContext(ActiveEditorContext.key, MULTI_DIFF_EDITOR_ID);
		assert.deepEqual(
			menus.getMenuActions(MenuId.EditorTitle).map(([group, actions]) => [group, actions.map(action => action.id)]),
			[
				['navigation', [MultiDiffGoToPreviousChangeCommandId, MultiDiffGoToNextChangeCommandId, MultiDiffToggleCollapseAllCommandId]],
				['1_diff', [MultiDiffToggleCollapseUnchangedRegionsCommandId]],
			],
		);
		const { MultiDiffEditorAllCollapsed, MultiDiffEditorHideUnchangedRegions } = await import('../../browser/multiDiffEditor.js');
		contexts.setContext(MultiDiffEditorHideUnchangedRegions.key, true);
		assert.equal(menus.getMenuActions(MenuId.EditorTitle)[1]![1][0]!.checked, true);
		contexts.setContext(MultiDiffEditorHideUnchangedRegions.key, false);
		assert.equal(menus.getMenuActions(MenuId.EditorTitle)[1]![1][0]!.checked, false);
		let toggle = menus.getMenuActions(MenuId.EditorTitle)[0]![1][2]!;
		assert.equal(toggle.checked, false);
		assert.equal(toggle.tooltip, 'Collapse All Diffs');
		contexts.setContext(MultiDiffEditorAllCollapsed.key, true);
		toggle = menus.getMenuActions(MenuId.EditorTitle)[0]![1][2]!;
		assert.equal(toggle.checked, true);
		assert.equal(toggle.tooltip, 'Expand All Diffs');
		assert.equal(toggle.icon, new MultiDiffToggleCollapseAllAction().desc.icon);
		const targetInput = { resource: URI.parse('file:///workspace/src/first.ts') };
		const fileActions = menus.getMenuActions(MenuId.MultiDiffEditorFileToolbar, { arg: targetInput });
		assert.deepEqual(
			fileActions.map(([group, actions]) => [group, actions.map(action => action.id)]),
			[['navigation', [MultiDiffGoToFileCommandId]]],
		);
		await fileActions[0]![1][0]!.run();
		assert.deepEqual(openedInputs, [targetInput]);

		await commands.executeCommand(MultiDiffGoToNextChangeCommandId);
		await commands.executeCommand(MultiDiffGoToPreviousChangeCommandId);
		await commands.executeCommand(MultiDiffCollapseAllCommandId);
		await commands.executeCommand(MultiDiffExpandAllCommandId);
		await commands.executeCommand(MultiDiffToggleCollapseAllCommandId);
		await commands.executeCommand(MultiDiffToggleCollapseUnchangedRegionsCommandId);
		assert.deepEqual(pane.calls, ['next', 'previous', 'collapse', 'expand', 'toggleCollapse', 'toggleUnchanged']);
		const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		setNlsMessages(chinese.locale, chinese.bundles);
		assert.deepEqual(
			[new MultiDiffCollapseAllAction(), new MultiDiffExpandAllAction(), new MultiDiffToggleCollapseUnchangedRegionsAction()].map(action => commandActionLabel(action.desc.title)),
			['折叠所有差异', '展开所有差异', '切换折叠未变更区域'],
		);
		const chineseToggle = new MultiDiffToggleCollapseAllAction().desc;
		assert.equal(commandActionLabel(chineseToggle.title), '折叠所有差异');
		assert.ok(chineseToggle.toggled && 'condition' in chineseToggle.toggled);
		assert.equal(commandActionLabel(chineseToggle.toggled.tooltip!), '展开所有差异');
	} finally {
		resetNlsResolver();
		for (const name of installedGlobals) Reflect.deleteProperty(globalThis, name);
		browser.window.close();
	}
});

function installDomGlobals(browser: JSDOM): readonly string[] {
	const globals = {
		window: browser.window,
		document: browser.window.document,
		Node: browser.window.Node,
		Element: browser.window.Element,
		HTMLElement: browser.window.HTMLElement,
		Event: browser.window.Event,
		MouseEvent: browser.window.MouseEvent,
		KeyboardEvent: browser.window.KeyboardEvent,
		navigator: browser.window.navigator,
	};
	for (const [name, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, name, { configurable: true, value });
	}
	return Object.keys(globals);
}

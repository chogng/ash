import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { ContextKeyService } from "../../../../../platform/contextkey/browser/contextKeyService.js";
import { IInstantiationService, ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IEditorPart as IEditorPartShape } from '../../../../browser/parts/editor/editorPart.js';
import { ActiveEditorContext } from '../../../../common/contextkeys.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IEditorService, type EditorInput } from '../../../../services/editor/common/editorService.js';
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';

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
			MultiDiffGoToFileAction,
			MultiDiffGoToFileCommandId,
			MultiDiffGoToNextChangeAction,
			MultiDiffGoToNextChangeCommandId,
			MultiDiffGoToPreviousChangeAction,
			MultiDiffGoToPreviousChangeCommandId,
		} = await import('../../browser/multiDiffEditorActions.js');
		const { MULTI_DIFF_EDITOR_ID } = await import('../../browser/multiDiffEditorInput.js');
		const { MultiDiffEditorPane } = await import('../../browser/multiDiffEditorPane.js');
		class TrackingMultiDiffEditorPane extends MultiDiffEditorPane {
			public readonly calls: string[] = [];

			constructor(@IInstantiationService instantiationService: IInstantiationService) {
				super({
					modelService: {
						acquire: async () => { throw new Error('Not used'); },
						dispose() {},
						[Symbol.dispose]() {},
					},
					createComputationService: () => ({
						compute: async () => { throw new Error('Not used'); },
						dispose() {},
						[Symbol.dispose]() {},
					}),
				}, instantiationService);
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
		}

		using registrations = new DisposableStore();
		registrations.add(registerAction2(MultiDiffGoToNextChangeAction));
		registrations.add(registerAction2(MultiDiffGoToPreviousChangeAction));
		registrations.add(registerAction2(MultiDiffCollapseAllAction));
		registrations.add(registerAction2(MultiDiffExpandAllAction));
		registrations.add(registerAction2(MultiDiffGoToFileAction));
		const services = new ServiceContainer();
		const pane = services.createInstance(TrackingMultiDiffEditorPane);
		registrations.add(pane);
		services.registerInstance(IEditorPart, { activePane: pane } as unknown as IEditorPartShape);
		const openedInputs: EditorInput[] = [];
		services.registerInstance(IEditorService, {
			...emptyEditorServiceState,
			async openEditor(input) { openedInputs.push(input); },
			focusActiveEditor() {},
		});
		using commands = new CommandService(services);
		using contexts = new ContextKeyService();
		const menus = new MenuService(commands, contexts);

		assert.deepEqual(menus.getMenuActions(MenuId.EditorTitle), []);
		contexts.setContext(ActiveEditorContext.key, MULTI_DIFF_EDITOR_ID);
		assert.deepEqual(
			menus.getMenuActions(MenuId.EditorTitle).map(([group, actions]) => [group, actions.map((action) => action.id)]),
			[
				['navigation', [MultiDiffGoToPreviousChangeCommandId, MultiDiffGoToNextChangeCommandId]],
				['4_collapse', [MultiDiffCollapseAllCommandId, MultiDiffExpandAllCommandId]],
			],
		);
		const targetInput = { resource: URI.parse('file:///workspace/src/first.ts') };
		const fileActions = menus.getMenuActions(MenuId.MultiDiffEditorFileToolbar, { arg: targetInput });
		assert.deepEqual(fileActions.map(([group, actions]) => [group, actions.map((action) => action.id)]), [
			['navigation', [MultiDiffGoToFileCommandId]],
		]);
		await fileActions[0]![1][0]!.run();
		assert.deepEqual(openedInputs, [targetInput]);

		await commands.executeCommand(MultiDiffGoToNextChangeCommandId);
		await commands.executeCommand(MultiDiffGoToPreviousChangeCommandId);
		await commands.executeCommand(MultiDiffCollapseAllCommandId);
		await commands.executeCommand(MultiDiffExpandAllCommandId);
		assert.deepEqual(pane.calls, ['next', 'previous', 'collapse', 'expand']);
	} finally {
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

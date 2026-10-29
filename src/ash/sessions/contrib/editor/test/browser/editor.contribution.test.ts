import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import { CommandService } from '../../../../../workbench/services/commands/common/commandService.js';
import { productLanguagePackCatalogs } from '../../../../../workbench/services/localization/common/localizationCatalogs.js';
import { resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { Menus } from '../../../../browser/menus.js';
import { NEW_FILE_TAB_COMMAND_ID } from '../../../../common/sessionCommands.js';
import type { IAgentWorkbenchLayoutService } from '../../../../browser/workbench.js';
import type { DesktopLayoutController, IDesktopLayoutContext } from '../../../layout/browser/desktopLayoutController.js';
import { EditorTitleMenuBridgeContribution } from '../../browser/editor.contribution.js';

test('editor contributions follow layout state, serialize Add tab commands and release window registrations', async () => {
	using services = new InstantiationService();
	using contextKeys = new ContextKeyService();
	using commands = new CommandService(services);
	using layoutChanged = new Emitter<void>();
	using editorChanged = new Emitter<void>();
	const documentContent = observableValue('document content', true);
	const parts = { editor: false, auxiliarybar: true };
	const effects: string[] = [];
	const pending = new DeferredPromise<void>();
	const started = new DeferredPromise<void>();
	let queue = Promise.resolve();
	let supportsDetails = true;
	const context: IDesktopLayoutContext = {
		isSessionContent: true,
		get isDocumentContent() {
			return documentContent.get();
		},
		documentContent,
		isChangingContent: false,
		runOperation(operation) {
			queue = queue.then(operation);
			return queue;
		},
	};
	const controller = {
		get supportsDetails() {
			return supportsDetails;
		},
		async openFiles() {
			await started.complete();
			await pending.p;
			effects.push('files');
		},
		async openChanges() {
			effects.push('changes');
		},
		async hideEditor() {
			parts.editor = false;
			parts.auxiliarybar = true;
		},
		async showEditor() {
			parts.editor = true;
		},
		async toggleDetails() {
			parts.auxiliarybar = !parts.auxiliarybar;
		},
		async toggleSidePane() {
			parts.editor = false;
			parts.auxiliarybar = false;
		},
	} as unknown as DesktopLayoutController;
	services.registerInstance(ILayoutService, {
		isPartVisible: (part: keyof typeof parts) => parts[part],
		onDidLayoutMainContainer: layoutChanged.event,
	} as unknown as IAgentWorkbenchLayoutService);
	services.registerInstance(IEditorPart, { onDidChangeEditors: editorChanged.event } as unknown as IEditorPart);
	services.registerInstance(IContextKeyService, contextKeys);
	const menus = new MenuService(commands, contextKeys);
	using title = menus.createMenu(MenuId.EditorTitle);
	using addTab = menus.createMenu(Menus.CodeAddTab);
	using palette = menus.createMenu(MenuId.CommandPalette);
	const paletteIds = () =>
		palette
			.getActions()
			.flatMap(([, actions]) => actions)
			.map(action => action.id)
			.sort();
	// Shared editor imports may already contribute commands to the same registry.
	const existingPaletteIds = paletteIds();
	using contribution = services.createInstance(EditorTitleMenuBridgeContribution, controller, context);
	const titleState = () =>
		title
			.getActions()
			.flatMap(([, actions]) => actions)
			.map(action => [action.label, action.enabled, action.checked]);
	assert.deepEqual(titleState(), [
		['Add tab', true, undefined],
		['Toggle details', true, true],
		['Show editor', true, undefined],
	]);
	assert.deepEqual(
		addTab
			.getActions()
			.flatMap(([, actions]) => actions)
			.map(action => action.id),
		[NEW_FILE_TAB_COMMAND_ID, 'workbench.agentSessions.action.viewChanges'],
	);
	assert.deepEqual(
		paletteIds(),
		[...existingPaletteIds, NEW_FILE_TAB_COMMAND_ID, 'workbench.agentSessions.action.viewChanges', 'ash.sessions.toggleSidePane', 'ash.sessions.toggleDetails', 'ash.sessions.showEditor'].sort(),
	);

	await commands.executeCommand('ash.sessions.showEditor');
	assert.deepEqual(titleState(), [
		['Add tab', true, undefined],
		['Toggle details', true, true],
		['Hide editor', true, undefined],
	]);
	await commands.executeCommand('ash.sessions.toggleDetails');
	assert.equal(contextKeys.getValue('sessions.detailsVisible'), false);
	supportsDetails = false;
	editorChanged.fire();
	assert.equal(
		title
			.getActions()
			.flatMap(([, actions]) => actions)
			.find(action => action.id === 'ash.sessions.toggleDetails')?.enabled,
		false,
	);
	parts.editor = false;
	layoutChanged.fire();
	assert.equal(contextKeys.getValue('sessions.editorContentVisible'), false);

	const files = commands.executeCommand(NEW_FILE_TAB_COMMAND_ID);
	await started.p;
	const changes = commands.executeCommand('workbench.agentSessions.action.viewChanges');
	assert.deepEqual(effects, []);
	await pending.complete();
	await Promise.all([files, changes]);
	assert.deepEqual(effects, ['files', 'changes']);
	documentContent.set(false, undefined);
	assert.deepEqual(title.getActions(), []);
	assert.deepEqual(paletteIds(), existingPaletteIds);
	await commands.executeCommand('workbench.agentSessions.action.viewChanges');
	assert.deepEqual(effects, ['files', 'changes']);

	contribution.dispose();
	assert.deepEqual(addTab.getActions(), []);
	assert.deepEqual(paletteIds(), existingPaletteIds);
	assert.equal(CommandsRegistry.getCommand('workbench.agentSessions.action.viewChanges'), undefined);
	assert.equal(CommandsRegistry.getCommand(NEW_FILE_TAB_COMMAND_ID), undefined);
	assert.equal(CommandsRegistry.getCommand('ash.sessions.openFilesTab'), undefined);
	for (const id of ['toggleDetails', 'hideEditor', 'showEditor', 'toggleSidePane']) {
		assert.equal(CommandsRegistry.getCommand('ash.sessions.' + id), undefined);
	}
	assert.equal(layoutChanged.hasListeners(), false);
	assert.equal(editorChanged.hasListeners(), false);
	assert.equal(contextKeys.getValue('sessions.detailsVisible'), false);
	assert.equal(contextKeys.getValue('sessions.supportedDetails'), false);

	const catalog = productLanguagePackCatalogs.find(pack => pack.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, original) => catalog.bundles[bundle]?.[key] ?? original);
		documentContent.set(true, undefined);
		using translated = services.createInstance(EditorTitleMenuBridgeContribution, controller, context);
		assert.deepEqual(
			titleState().map(([label]) => label),
			['添加标签', '切换详情', '显示编辑器'],
		);
		assert.deepEqual(
			addTab
				.getActions()
				.flatMap(([, actions]) => actions)
				.map(action => action.label),
			['打开文件标签', '打开更改标签'],
		);
	} finally {
		resetNlsResolver();
	}
});

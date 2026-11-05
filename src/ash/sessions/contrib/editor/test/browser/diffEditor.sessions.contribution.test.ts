import '../../../../../editor/test/browser/testEditorDom.js';
import '../../../../../workbench/contrib/codeEditor/common/editorConfiguration.js';
import '../../../changes/browser/changes.contribution.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { MenuId, SubmenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { SET_DIFF_VIEW_MODE_AUTOMATIC, SET_DIFF_VIEW_MODE_INLINE, SET_DIFF_VIEW_MODE_SIDE_BY_SIDE, TOGGLE_DIFF_SIDE_BY_SIDE } from '../../../../../workbench/browser/parts/editor/diffEditorCommands.js';
import { IDiffEditorCommandsService } from '../../../../../workbench/browser/parts/editor/diffEditorCommandsService.js';
import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import { ActiveEditorContext } from '../../../../../workbench/common/contextkeys.js';
import { DIFF_EDITOR_ID } from '../../../../../workbench/common/editor/diffEditorInput.js';
import { CommandService } from '../../../../../workbench/services/commands/common/commandService.js';
import { testConfigurationService } from '../../../../../workbench/services/configuration/test/common/testServices.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { emptyEditorServiceState } from '../../../../../workbench/test/common/testEditorService.js';
import { SESSIONS_DIFF_VIEW_MODE } from '../../../../common/configuration.js';
import { ConfigurationService } from '../../../../services/configuration/browser/configurationService.js';
import { SessionChangesEditor } from '../../../changes/browser/sessionChangesEditor.js';
import { SessionsDiffEditorCommandsService } from '../../browser/diffEditor.sessions.contribution.js';

test('Changes can set the shared diff view without a mounted diff and the single-file toggle restores Automatic', async () => {
	using configuration = new (testConfigurationService(ConfigurationService))();
	using services = new InstantiationService();
	using contexts = new ContextKeyService();
	using commands = new CommandService(services);
	const menuService = new MenuService(commands, contexts);
	const activeEditor = ActiveEditorContext.bindTo(contexts);
	const changesGroupId = 2;
	let paneId = 'test.codeEditor';
	services.registerInstance(IEditorPart, {
		get activePane() { return { id: paneId, getControl: () => undefined }; },
		activateGroup(id: number) {
			assert.equal(id, changesGroupId);
			paneId = SessionChangesEditor.ID;
		},
	} as unknown as IEditorPart);
	services.registerInstance(IEditorService, {
		...emptyEditorServiceState,
		openEditor: async () => undefined,
		focusActiveEditor: () => { },
	});
	services.registerInstance(IConfigurationService, configuration);
	services.registerSingleton(IDiffEditorCommandsService, () => services.createInstance(SessionsDiffEditorCommandsService));

	const diffView = () => menuService.getMenuActions(MenuId.EditorTitle, { arg: { groupId: changesGroupId } })
		.flatMap(([, actions]) => actions)
		.find((action): action is SubmenuItemAction => action instanceof SubmenuItemAction && action.item.submenu === MenuId.DiffEditorViewSubmenu);
	activeEditor.set(paneId);
	assert.equal(diffView(), undefined);
	activeEditor.set(SessionChangesEditor.ID);
	const actions = diffView()?.actions;
	assert.ok(actions);
	assert.deepEqual(actions.map(action => [action.id, action.enabled]), [
		[SET_DIFF_VIEW_MODE_INLINE, true],
		[SET_DIFF_VIEW_MODE_SIDE_BY_SIDE, true],
		[SET_DIFF_VIEW_MODE_AUTOMATIC, true],
	]);
	await actions[1].run();
	assert.equal(paneId, SessionChangesEditor.ID);
	assert.equal(configuration.getValue(SESSIONS_DIFF_VIEW_MODE), 'sideBySide');
	await commands.executeCommand(TOGGLE_DIFF_SIDE_BY_SIDE);
	assert.equal(configuration.getValue(SESSIONS_DIFF_VIEW_MODE), 'inline');

	paneId = DIFF_EDITOR_ID;
	await commands.executeCommand(TOGGLE_DIFF_SIDE_BY_SIDE);
	assert.equal(configuration.getValue(SESSIONS_DIFF_VIEW_MODE), 'automatic');
	assert.equal(configuration.getValue('diffEditor.useInlineViewWhenSpaceIsLimited'), true);
	await commands.executeCommand(TOGGLE_DIFF_SIDE_BY_SIDE);
	assert.equal(configuration.getValue(SESSIONS_DIFF_VIEW_MODE), 'inline');
	await commands.executeCommand(TOGGLE_DIFF_SIDE_BY_SIDE);
	assert.equal(configuration.getValue(SESSIONS_DIFF_VIEW_MODE), 'automatic');
});

import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../../base/common/network.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IChatSessionNavigationService } from '../../../../../services/chat/common/chatSessionNavigationService.js';
import { IEditorGroupsService } from '../../../../../services/editor/common/editorGroupsService.js';
import { IViewsService } from '../../../../../services/views/common/viewsService.js';
import { CHAT_VIEW_ID, MOVE_CHAT_TO_EDITOR_COMMAND_ID, MOVE_CHAT_TO_NEW_WINDOW_COMMAND_ID } from '../../../common/chat.js';
import { registerMoveActions } from '../../../browser/actions/chatMoveActions.js';
import type { IChatViewPane } from '../../../browser/chat.js';

registerMoveActions();

test('Workbench move commands invoke the registered host without a Sessions implementation', async () => {
	using resources = new DisposableStore();
	const services = resources.add(new InstantiationService());
	const calls: string[] = [];
	const host = {
		moveToEditor: async () => { calls.push('editor'); },
		openInNewWindow: async () => { calls.push('window'); },
	} as IChatViewPane;
	services.registerInstance(IViewsService, {
		openView: async (id: string) => { assert.equal(id, CHAT_VIEW_ID); return host; },
	} as unknown as IViewsService);
	await services.invokeFunction(CommandsRegistry.getCommand(MOVE_CHAT_TO_EDITOR_COMMAND_ID)!);
	await services.invokeFunction(CommandsRegistry.getCommand(MOVE_CHAT_TO_NEW_WINDOW_COMMAND_ID)!);
	assert.deepEqual(calls, ['editor', 'window']);
});

test('Returning Chat to the sidebar captures the draft and cancels when navigation changes', async () => {
	using resources = new DisposableStore();
	const services = resources.add(new InstantiationService());
	const pending = new DeferredPromise<void>();
	let revision = 0;
	const calls: string[] = [];
	services.registerInstance(IChatSessionNavigationService, {
		get revision() { return revision; },
		captureActiveDraft: async () => { calls.push('capture'); await pending.p; return undefined; },
	} as IChatSessionNavigationService);
	const input = { resource: { scheme: Schemas.vscodeChatEditor } };
	const other = { resource: { scheme: Schemas.file } };
	services.registerInstance(IEditorGroupsService, {
		groups: [{ inputs: [input, other], closeEditor: async (value: unknown) => { assert.equal(value, input); calls.push('close'); } }],
	} as unknown as IEditorGroupsService);
	services.registerInstance(IViewsService, {
		focusView: async (id: string) => { assert.equal(id, CHAT_VIEW_ID); calls.push('focus'); },
	} as unknown as IViewsService);
	const command = CommandsRegistry.getCommand('workbench.action.chat.moveToSideBar')!;
	const moving = services.invokeFunction(command);
	revision++;
	await pending.complete();
	await moving;
	assert.deepEqual(calls, ['capture']);
	calls.length = 0;
	await services.invokeFunction(command);
	assert.deepEqual(calls, ['capture', 'close', 'focus']);
});

import '../../../editor/test/browser/testEditorDom.js';
import '../../browser/actions/sessionsChatActions.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../base/common/event.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService, type IQuickPick, type IQuickPickDidAcceptEvent, type IQuickInputHideEvent } from '../../../platform/quickinput/common/quickInput.js';
import { quickInputServiceTestControls } from '../../../platform/quickinput/test/browser/testQuickInputService.js';
import type { IChatWidgetModel } from '../../../workbench/contrib/chat/browser/widget/chatWidget.js';

for (const retired of [false, true]) test(`Permission selection stays with its originating composer (retired ${retired})`, async () => {
	using lifetime = new DisposableStore();
	const services = lifetime.add(new InstantiationService());
	const accepted = lifetime.add(new Emitter<IQuickPickDidAcceptEvent>());
	const hidden = lifetime.add(new Emitter<IQuickInputHideEvent>());
	const calls: string[] = [];
	const model = { composerGeneration: 1, inputState: {}, selectApprovalMode: (mode: string) => calls.push(mode) } as unknown as IChatWidgetModel;
	const picker = { selectedItems: [{ id: 'manual' }], onDidAccept: accepted.event, onDidHide: hidden.event, show() { }, hide() { hidden.fire({ reason: 3 }); }, dispose() { }, [Symbol.dispose]() { } } as unknown as IQuickPick<{ label: string; id: string; }>;
	services.registerInstance(IQuickInputService, { ...quickInputServiceTestControls, createQuickPick: () => picker, input: async () => undefined } as IQuickInputService);
	services.registerInstance(ICommandService, { executeCommand: async (id: string, value: unknown) => services.invokeFunction(CommandsRegistry.getCommand(id)!, value) } as unknown as ICommandService);
	const operation = services.invokeFunction(CommandsRegistry.getCommand('chat.permission')!, model) as Promise<void>;
	if (retired) Object.assign(model, { composerGeneration: 2 });
	accepted.fire({ inBackground: false });
	await operation;
	assert.deepEqual(calls, retired ? [] : ['manual']);
});

for (const change of ['switch', 'disable', 'none'] as const) test(`A delayed permission confirmation cannot apply to a changed composer (${change})`, async () => {
	using services = new InstantiationService();
	const confirmation = new DeferredPromise<{ confirmed: boolean; }>();
	services.registerInstance(IDialogService, { confirm: () => confirmation.p } as unknown as IDialogService);
	const calls: string[] = [];
	const state = { aiDisabled: false };
	const model = { composerGeneration: 1, inputState: state, selectApprovalMode: (mode: string) => calls.push(mode) } as unknown as IChatWidgetModel;
	const operation = services.invokeFunction(CommandsRegistry.getCommand('sessions.chat.permission.bypassPermissions')!, model) as Promise<void>;
	if (change === 'switch') Object.assign(model, { composerGeneration: 2 });
	if (change === 'disable') state.aiDisabled = true;
	await confirmation.complete({ confirmed: true });
	await operation;
	assert.deepEqual(calls, change === 'none' ? ['bypassPermissions'] : []);
});

import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { OpenAgentTraceCommandId, createAgentTraceResource } from '../../browser/chatDebug/chatDebugEditorInput.js';
import { registerChatOpenAgentDebugPanelAction } from '../../browser/actions/chatOpenAgentDebugPanelAction.js';
registerChatOpenAgentDebugPanelAction();

suite('Execution Trace command', () => {
	for (const target of [
		undefined,
		'session',
		{ sessionId: 'session', threadId: 'child', turnId: 'turn', eventId: 'event' },
	]) {
		test(`opens the saved location through the registered command ${JSON.stringify(target)}`, async () => {
			using services = new InstantiationService();
			const opened: IResourceEditorInput[] = [];
			services.registerInstance(IStorageService, { store() {} } as unknown as IStorageService);
			services.registerInstance(IEditorService, {
				openEditor: async (input: IResourceEditorInput) => {
					opened.push(input);
				},
			} as unknown as IEditorService);
			await services.invokeFunction(CommandsRegistry.getCommand(OpenAgentTraceCommandId)!, target);
			assert.deepEqual(
				opened.map(input => ({ resource: input.resource.toString(), readOnly: input.readOnly })),
				[{ resource: createAgentTraceResource(target).toString(), readOnly: true }],
			);
		});
	}
});

suite('Workbench Trace navigation', () => {
	for (const saved of [
		undefined,
		'ash-agent-trace:/session?threadId=child&turnId=turn',
		'https://example.test/untrusted',
	]) {
		test(`resumes only a valid readonly Trace locator ${String(saved)}`, async () => {
			using services = new InstantiationService();
			const opened: IResourceEditorInput[] = [];
			services.registerInstance(IStorageService, { get: () => saved, store() {} } as unknown as IStorageService);
			services.registerInstance(IEditorService, {
				openEditor: async (input: IResourceEditorInput) => {
					opened.push(input);
				},
			} as unknown as IEditorService);
			await services.invokeFunction(CommandsRegistry.getCommand('ash.agentTrace.resume')!);
			assert.deepEqual(
				opened.map(input => ({ resource: input.resource.toString(), readOnly: input.readOnly })),
				[
					{
						resource: saved?.startsWith('ash-agent-trace:') ? saved : 'ash-agent-trace:/import',
						readOnly: true,
					},
				],
			);
		});
	}
});

test('Show Agent Debug Logs uses the current conversation through the shared navigation owner', async () => {
	using services = new InstantiationService();
	const opened: IResourceEditorInput[] = [];
	services.registerInstance(IStorageService, { store() {} } as unknown as IStorageService);
	services.registerInstance(IEditorService, {
		openEditor: async (input: IResourceEditorInput) => {
			opened.push(input);
		},
	} as unknown as IEditorService);
	services.registerInstance(IChatSessionNavigationService, {
		getActiveConversation: () => ({ sessionId: 'session', threadId: 'child' }),
	} as IChatSessionNavigationService);
	await services.invokeFunction(CommandsRegistry.getCommand('workbench.action.chat.openAgentDebugPanelForSession')!);
	assert.deepEqual(
		opened.map(input => input.resource.toString()),
		['ash-agent-trace:/session?threadId=child'],
	);
});

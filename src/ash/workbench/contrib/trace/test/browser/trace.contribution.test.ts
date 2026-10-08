import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { OpenAgentTraceCommandId, createAgentTraceResource } from '../../common/trace.js';
import '../../browser/trace.contribution.js';

suite('Execution Trace command', () => {
	for (const target of [undefined, 'session', { sessionId: 'session', threadId: 'child', turnId: 'turn', eventId: 'event' }]) {
		test(`opens the saved location through the registered command ${JSON.stringify(target)}`, async () => {
			using services = new InstantiationService();
			const opened: IResourceEditorInput[] = [];
			services.registerInstance(IEditorService, { openEditor: async (input: IResourceEditorInput) => { opened.push(input); } } as unknown as IEditorService);
			await services.invokeFunction(CommandsRegistry.getCommand(OpenAgentTraceCommandId)!, target);
			assert.deepEqual(opened.map(input => ({ resource: input.resource.toString(), readOnly: input.readOnly })), [
				{ resource: createAgentTraceResource(target).toString(), readOnly: true },
			]);
		});
	}
});

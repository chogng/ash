import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ConfirmResult } from '../../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IEditorService, type EditorOpenOptions, type EditorOpenTarget } from '../../../../../services/editor/common/editorService.js';
import { IEditorGroupsService, type IEditorGroup } from '../../../../../services/editor/common/editorGroupsService.js';
import { IViewsService } from '../../../../../services/views/common/viewsService.js';
import type { IResourceEditorInput } from '../../../../../common/editor.js';
import { clearChatEditor } from '../../../browser/actions/chatClear.js';
import { ChatEditorInput } from '../../../browser/widgetHosts/editor/chatEditorInput.js';
import { registerNewChatActions } from '../../../browser/actions/chatNewActions.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';

registerNewChatActions();

suite('New Chat in an editor', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the editor title targets its active chat even when several tabs are selected', async () => {
		using services = new InstantiationService();
		using source = new ChatEditorInput('session:source');
		using other = new ChatEditorInput('session:other');
		using replacement = new ChatEditorInput('untitled:new');
		const inputs: IResourceEditorInput[] = [other, source];
		const group = {
			id: 7, inputs, activeInput: source, selectedInputs: [other, source],
			editors: [{ input: other }, { input: source }], isSticky: () => false,
			closeEditor: async (input: IResourceEditorInput) => {
				assert.equal(input, source);
				inputs.splice(inputs.indexOf(input), 1);
				return true;
			},
		} as unknown as IEditorGroup;
		services.registerInstance(IConfigurationService, { getValue: () => false } as unknown as IConfigurationService);
		services.registerInstance(IEditorGroupsService, { groups: [group], getGroup: () => group } as unknown as IEditorGroupsService);
		services.registerInstance(IEditorService, {
			activeEditor: other,
			openEditor: async (input: IResourceEditorInput, options?: EditorOpenOptions, target?: EditorOpenTarget) => {
				assert.deepEqual(target, { groupId: 7 });
				assert.equal(options?.index, 1);
				inputs.push(input);
			},
		} as unknown as IEditorService);
		services.registerInstance(IViewsService, {
			openView: async () => ({ createNewChatEditorInput: (input: ChatEditorInput) => { assert.equal(input, source); return replacement; } }),
		} as unknown as IViewsService);
		await services.invokeFunction(CommandsRegistry.getCommand('workbench.action.chatEditor.newChat')!, { groupId: 7 });
		assert.deepEqual(inputs, [other, replacement]);
	});

	for (const outcome of ['replace', 'closed', 'failure', 'cancel'] as const) {
		test(`captures the source and preserves its group (${outcome})`, async () => {
			using services = new InstantiationService();
			using source = new ChatEditorInput('session:source', 'Source');
			using replacement = new ChatEditorInput('untitled:new', 'New Chat');
			const capture = new DeferredPromise<ConfirmResult>();
			let captures = 0;
			let creations = 0;
			let closes = 0;
			const inputs: IResourceEditorInput[] = [source];
			const group = {
				id: 7, inputs, isSticky: () => true,
				stickEditor: (input: IResourceEditorInput) => assert.equal(input, replacement),
				closeEditor: async (input: IResourceEditorInput) => {
					assert.equal(input, source);
					inputs.splice(inputs.indexOf(input), 1);
					closes++;
					return true;
				},
			} as unknown as IEditorGroup;
			source.closeHandler = { showConfirm: () => true, confirm: () => { captures++; return capture.p; } };
			services.registerInstance(IEditorService, {
				activeEditor: source,
				openEditor: async (input: IResourceEditorInput, options?: EditorOpenOptions, target?: EditorOpenTarget) => {
					assert.equal(input, replacement);
					assert.deepEqual(target, { groupId: 7 });
					assert.equal(options?.index, 0);
					assert.equal(options?.pinned, true);
					if (outcome === 'failure') throw new Error('Editor could not open');
					inputs.unshift(input);
				},
			} as unknown as IEditorService);
			services.registerInstance(IEditorGroupsService, { groups: [group], getGroup: () => group } as unknown as IEditorGroupsService);
			services.registerInstance(IViewsService, {
				openView: async () => ({ createNewChatEditorInput: () => { creations++; return replacement; } }),
			} as unknown as IViewsService);
			const run = services.invokeFunction(clearChatEditor);
			await services.invokeFunction(clearChatEditor);
			assert.equal(captures, 1, 'a second activation shares the pending operation');
			assert.equal(creations, 0, 'a pending attachment capture cannot retire the old composer');
			if (outcome === 'closed') inputs.length = 0;
			await capture.complete(outcome === 'cancel' ? ConfirmResult.CANCEL : ConfirmResult.DONT_SAVE);
			if (outcome === 'failure') await assert.rejects(run, /Editor could not open/u);
			else await run;
			assert.equal(creations, outcome === 'replace' || outcome === 'failure' ? 1 : 0);
			assert.equal(closes, outcome === 'replace' ? 1 : 0);
			if (outcome === 'failure' || outcome === 'cancel') assert.deepEqual(inputs, [source]);
			if (outcome === 'replace') assert.deepEqual(inputs, [replacement]);
		});
	}
});

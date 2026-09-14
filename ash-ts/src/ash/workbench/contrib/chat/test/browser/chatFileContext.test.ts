import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import type { ChatContextPicker, IChatContextPickService } from '../../../../services/chat/common/chatContextService.js';
import type { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ChatFileContextContribution } from '../../browser/chatFileContext.js';

suite('Chat file context', () => {
	test('explicit open-file attachment carries its path and saved content', async () => {
		const resource = URI.file('/workspace/src/example.ts');
		let picker: ChatContextPicker | undefined;
		const contextPicks = {
			registerPicker(value: ChatContextPicker) {
				picker = value;
				return toDisposable(() => { picker = undefined; });
			},
		} as IChatContextPickService;
		const editors = {
			visibleEditors: [{ resource, label: 'example.ts' }],
		} as unknown as IEditorService;
		const files = {
			readFile: async () => ({ resource, content: 'export const answer = 42;\n', revision: 'revision' }),
		} as unknown as IFileService;
		using contribution = new ChatFileContextContribution(contextPicks, editors, files);

		assert.equal(picker?.isEnabled(), true);
		const picks = await picker?.providePicks('example');
		assert.equal(picks?.length, 1);
		assert.deepEqual(await picks?.[0]?.attachment.resolve(), {
			name: 'File /workspace/src/example.ts',
			content: 'export const answer = 42;\n',
			filePath: '/workspace/src/example.ts',
		});
	});
});

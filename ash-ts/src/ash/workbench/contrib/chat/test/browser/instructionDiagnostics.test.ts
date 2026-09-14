import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DialogSeverity, type IDialogService, type IMessageDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import type { IInstructionApi } from '../../../../../platform/instructions/common/instructionApi.js';
import { showInstructionDiagnostics } from '../../browser/promptSyntax/instructionDiagnostics.js';

suite('Instruction diagnostics', () => {
	test('shows the source and reason for invalid workspace files', async () => {
		let requestedSession: string | undefined;
		const api = {
			list: async (sessionId?: string) => {
				requestedSession = sessionId;
				return {
					instructions: [],
					diagnostics: [{
						source: { type: 'directory' as const, root: '/workspace' },
						relativePath: 'invalid.md',
						code: 'invalidFrontmatter' as const,
						message: 'Instruction frontmatter is invalid',
					}],
				};
			},
		} as IInstructionApi;
		const messages: IMessageDialogOptions[] = [];
		const dialogs = { showMessage: async (options: IMessageDialogOptions) => { messages.push(options); } } as IDialogService;

		await showInstructionDiagnostics(api, dialogs, 'session-1');

		assert.equal(requestedSession, 'session-1');
		assert.deepEqual(messages, [{
			severity: DialogSeverity.Warning,
			title: 'Instruction Diagnostics',
			message: '1 Instruction file problem found.',
			detail: '/workspace/.ash/instructions/invalid.md: Instruction frontmatter is invalid (invalidFrontmatter)',
		}]);
	});
});

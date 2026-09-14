import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DialogSeverity, type IDialogService, type IConfirmationDialogOptions, type IMessageDialogOptions } from '../../../../../platform/dialogs/common/dialogs.js';
import type { IInstructionImportApi, InstructionImportScope, InstructionImportSource } from '../../../../../platform/instructions/common/instructionImportApi.js';
import { importClaudeInstructions } from '../../browser/actions/claudeInstructionImport.js';

suite('Claude instruction import', () => {
	test('reviews exact source text and applies only after confirmation', async () => {
		const scope: InstructionImportScope = { type: 'workspace' };
		const source: InstructionImportSource = { relativePath: 'CLAUDE.md', content: 'Use these rules.\n', sha256: 'preview-digest' };
		const applied: { scope: InstructionImportScope; source: InstructionImportSource; target: string }[] = [];
		const imports = {
			preview: async () => ({ source, target: '/workspace/ASH.md', targetConflict: false, diagnostics: [] }),
			apply: async (selectedScope: InstructionImportScope, selectedSource: InstructionImportSource, target: string) => {
				applied.push({ scope: selectedScope, source: selectedSource, target });
				return { target: '/workspace/ASH.md', sha256: source.sha256 };
			},
		} as IInstructionImportApi;
		let confirmation: IConfirmationDialogOptions | undefined;
		const messages: IMessageDialogOptions[] = [];
		const dialogs = {
			confirm: async (options: IConfirmationDialogOptions) => { confirmation = options; return true; },
			showMessage: async (options: IMessageDialogOptions) => { messages.push(options); },
		} as unknown as IDialogService;

		await importClaudeInstructions(imports, dialogs, scope);

		assert.equal(confirmation?.detail, source.content);
		assert.deepEqual(applied, [{ scope, source, target: '/workspace/ASH.md' }]);
		assert.deepEqual(messages, [{
			severity: DialogSeverity.Info,
			title: 'Import Claude instructions',
			message: 'Claude instructions copied to Ash.',
			detail: '/workspace/ASH.md',
		}]);
	});

	test('keeps a nonempty Ash target untouched', async () => {
		let applied = false;
		const imports = {
			preview: async () => ({
				source: { relativePath: 'CLAUDE.md', content: 'External', sha256: 'digest' },
				target: '/workspace/ASH.md',
				targetConflict: true,
				diagnostics: [],
			}),
			apply: async () => { applied = true; throw new Error('must not apply'); },
		} as IInstructionImportApi;
		const messages: IMessageDialogOptions[] = [];
		const dialogs = {
			confirm: async () => { throw new Error('must not confirm'); },
			showMessage: async (options: IMessageDialogOptions) => { messages.push(options); },
		} as unknown as IDialogService;

		await importClaudeInstructions(imports, dialogs, { type: 'user' });
		assert.equal(applied, false);
		assert.equal(messages[0]?.severity, DialogSeverity.Warning);
	});
});

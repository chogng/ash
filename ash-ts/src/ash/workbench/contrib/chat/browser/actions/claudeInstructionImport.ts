import { DialogSeverity, type IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { IInstructionImportApi, InstructionImportScope } from '../../../../../platform/instructions/common/instructionImportApi.js';

/** Shows the exact external text before a confirmed, conflict-safe copy. */
export async function importClaudeInstructions(imports: IInstructionImportApi, dialogs: IDialogService, scope: InstructionImportScope): Promise<void> {
	try {
		const preview = await imports.preview(scope);
		if (!preview.source) {
			await dialogs.showMessage({
				severity: DialogSeverity.Info,
				title: 'Import Claude instructions',
				message: 'No Claude instruction file was found in this location.',
				detail: preview.diagnostics.map(diagnostic => `${diagnostic.relativePath}: ${diagnostic.code}`).join('\n') || undefined,
			});
			return;
		}
		if (preview.targetConflict) {
			await dialogs.showMessage({
				severity: DialogSeverity.Warning,
				title: 'Import Claude instructions',
				message: 'The Ash instruction file already has content.',
				detail: preview.target,
			});
			return;
		}
		const confirmed = await dialogs.confirm({
			title: 'Review Claude instructions',
			message: `Copy ${preview.source.relativePath} to ${preview.target}?`,
			detail: preview.source.content,
			primaryButton: 'Import',
		});
		if (!confirmed) return;
		const applied = await imports.apply(scope, preview.source, preview.target);
		await dialogs.showMessage({
			severity: DialogSeverity.Info,
			title: 'Import Claude instructions',
			message: 'Claude instructions copied to Ash.',
			detail: applied.target,
		});
	} catch (error) {
		await dialogs.showMessage({
			severity: DialogSeverity.Error,
			title: 'Import Claude instructions',
			message: 'Could not import Claude instructions.',
			detail: error instanceof Error ? error.message : String(error),
		});
	}
}

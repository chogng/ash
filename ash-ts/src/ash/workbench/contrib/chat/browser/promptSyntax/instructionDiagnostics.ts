import { DialogSeverity, type IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { IInstructionApi, InstructionCatalog } from '../../../../../platform/instructions/common/instructionApi.js';

export async function showInstructionDiagnostics(instructions: IInstructionApi, dialogs: IDialogService, sessionId?: string): Promise<void> {
	try {
		const catalog = await instructions.list(sessionId);
		const detail = catalog.diagnostics.map(diagnosticLine).join('\n');
		await dialogs.showMessage({
			severity: catalog.diagnostics.length > 0 ? DialogSeverity.Warning : DialogSeverity.Info,
			title: 'Instruction Diagnostics',
			message: catalog.diagnostics.length > 0
				? `${catalog.diagnostics.length} Instruction file problem${catalog.diagnostics.length === 1 ? '' : 's'} found.`
				: 'No Instruction file problems found.',
			detail: detail || undefined,
		});
	} catch (error) {
		await dialogs.showMessage({
			severity: DialogSeverity.Error,
			title: 'Instruction Diagnostics',
			message: 'Could not load Instruction diagnostics.',
			detail: error instanceof Error ? error.message : String(error),
		});
	}
}

function diagnosticLine(diagnostic: InstructionCatalog['diagnostics'][number]): string {
	const isRootFile = diagnostic.relativePath === 'AGENTS.md' || diagnostic.relativePath === 'ASH.md';
	const source = diagnostic.source.type === 'user'
		? (isRootFile ? 'User' : 'User instructions')
		: (isRootFile ? diagnostic.source.root : `${diagnostic.source.root}/.ash/instructions`);
	const path = diagnostic.relativePath ? `${source}/${diagnostic.relativePath}` : source;
	return `${path}: ${diagnostic.message} (${diagnostic.code})`;
}

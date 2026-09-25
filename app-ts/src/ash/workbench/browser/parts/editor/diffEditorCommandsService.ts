import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { createDiffEditorInput, isDiffEditorInput } from '../../../common/editor/diffEditorInput.js';
import { IEditorPart } from './editorPart.js';
import { TextDiffEditor } from './textDiffEditor.js';

export const IDiffEditorCommandsService = createServiceIdentifier<IDiffEditorCommandsService>('diffEditorCommandsService');

export const enum FocusTextDiffEditorMode {
	Original,
	Modified,
	Toggle,
}

export type DiffEditorViewMode = 'inline' | 'sideBySide' | 'automatic';

/** Operations on the active comparison, shared by command palette and keybindings. */
export interface IDiffEditorCommandsService {
	toggleRenderSideBySide(): Promise<void>;
	setViewMode(mode: DiffEditorViewMode): Promise<void>;
	navigateInDiffEditor(next: boolean): void;
	focusInDiffEditor(mode: FocusTextDiffEditorMode): void;
	openActiveDiffSide(): Promise<void>;
	toggleDiffIgnoreTrimWhitespace(): Promise<void>;
	swapDiffSides(): Promise<void>;
}

export class DiffEditorCommandsService implements IDiffEditorCommandsService {
	constructor(
		@IEditorPart private readonly editorPart: IEditorPart,
		@IEditorService private readonly editorService: IEditorService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {}

	async toggleRenderSideBySide(): Promise<void> {
		if (!this.activeControl()) return;
		const key = 'diffEditor.renderSideBySide';
		await this.configurationService.updateValue(key, !this.configurationService.getValue<boolean>(key));
	}

	async setViewMode(mode: DiffEditorViewMode): Promise<void> {
		if (!this.activeControl()) return;
		await this.configurationService.updateValue('diffEditor.renderSideBySide', mode !== 'inline');
		await this.configurationService.updateValue('diffEditor.useInlineViewWhenSpaceIsLimited', mode === 'automatic');
	}

	navigateInDiffEditor(next: boolean): void {
		const control = this.activeControl();
		if (!control) return;
		if (next) control.nextChange();
		else control.previousChange();
	}

	focusInDiffEditor(mode: FocusTextDiffEditorMode): void {
		const control = this.activeControl();
		if (!control) return;
		const original = control.originalEditor;
		const modified = control.modifiedEditor;
		const originalFocused = original.getDomNode().contains(original.getDomNode().ownerDocument.activeElement);
		if (mode === FocusTextDiffEditorMode.Original || mode === FocusTextDiffEditorMode.Toggle && !originalFocused) original.focus();
		else modified.focus();
	}

	async openActiveDiffSide(): Promise<void> {
		const input = this.editorPart.activeInput;
		const control = this.activeControl();
		if (!input || !control || !isDiffEditorInput(input)) return;
		const originalFocused = control.originalEditor.getDomNode().contains(control.originalEditor.getDomNode().ownerDocument.activeElement);
		await this.editorService.openEditor(originalFocused ? input.original : input.modified);
	}

	async toggleDiffIgnoreTrimWhitespace(): Promise<void> {
		const input = this.editorPart.activeInput;
		if (!input || !this.activeControl() || !isDiffEditorInput(input)) return;
		const key = 'diffEditor.ignoreTrimWhitespace';
		await this.configurationService.updateValue(key, !this.configurationService.getValue<boolean>(key));
	}

	async swapDiffSides(): Promise<void> {
		const input = this.editorPart.activeInput;
		if (!input || !this.activeControl() || !isDiffEditorInput(input)) return;
		await this.editorService.openEditor(createDiffEditorInput(input.modified, input.original));
		await this.editorPart.closeEditor(input);
	}

	private activeControl() {
		const pane = this.editorPart.activePane;
		return pane instanceof TextDiffEditor ? pane.getControl() : undefined;
	}
}

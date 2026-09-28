import { localizedString } from '../../../../platform/action/common/action.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICodeEditorService } from '../../services/codeEditorService.js';
import { DiffEditorWidget } from './diffEditorWidget.js';

export class AccessibleDiffViewerNext extends Action2 {
	public static readonly id = 'editor.action.accessibleDiffViewer.next';

	constructor() {
		super({ id: AccessibleDiffViewerNext.id, title: localizedString('ash', 'diffEditor.accessibleViewer.next', 'Next difference'), f1: true });
	}

	public override run(accessor: ServicesAccessor): void {
		findFocusedDiffEditor(accessor)?.accessibleDiffViewerNext();
	}
}

export class AccessibleDiffViewerPrev extends Action2 {
	public static readonly id = 'editor.action.accessibleDiffViewer.prev';

	constructor() {
		super({ id: AccessibleDiffViewerPrev.id, title: localizedString('ash', 'diffEditor.accessibleViewer.previous', 'Previous difference'), f1: true });
	}

	public override run(accessor: ServicesAccessor): void {
		findFocusedDiffEditor(accessor)?.accessibleDiffViewerPrev();
	}
}

export function findFocusedDiffEditor(accessor: ServicesAccessor): DiffEditorWidget | undefined {
	return accessor.get(ICodeEditorService).listDiffEditors().find(
		(editor): editor is DiffEditorWidget => editor instanceof DiffEditorWidget && editor.hasFocus(),
	);
}

registerAction2(AccessibleDiffViewerNext);
registerAction2(AccessibleDiffViewerPrev);

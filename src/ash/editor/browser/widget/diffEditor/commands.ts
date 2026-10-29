import { localize2 } from '../../../../nls.js';
import { Lxicon } from '../../../../base/common/lxicons.js';

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICodeEditorService } from '../../services/codeEditorService.js';
import { DiffEditorWidget } from './diffEditorWidget.js';

export class ToggleCollapseUnchangedRegions extends Action2 {
	constructor() {
		super({
			id: 'diffEditor.toggleCollapseUnchangedRegions',
			title: localize2('toggleCollapseUnchangedRegions', 'Toggle Collapse Unchanged Regions'),
			icon: Lxicon.map,
			toggled: ContextKeyExpr.has('config.diffEditor.hideUnchangedRegions.enabled'),
		});
	}

	public override run(accessor: ServicesAccessor): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		return configuration.updateValue('diffEditor.hideUnchangedRegions.enabled', !configuration.getValue<boolean>('diffEditor.hideUnchangedRegions.enabled'));
	}
}

export class AccessibleDiffViewerNext extends Action2 {
	public static readonly id = 'editor.action.accessibleDiffViewer.next';

	constructor() {
		super({ id: AccessibleDiffViewerNext.id, title: localize2({ bundle: 'ash', key: 'diffEditor.accessibleViewer.next' }, 'Next difference'), f1: true });
	}

	public override run(accessor: ServicesAccessor): void {
		findFocusedDiffEditor(accessor)?.accessibleDiffViewerNext();
	}
}

export class AccessibleDiffViewerPrev extends Action2 {
	public static readonly id = 'editor.action.accessibleDiffViewer.prev';

	constructor() {
		super({ id: AccessibleDiffViewerPrev.id, title: localize2({ bundle: 'ash', key: 'diffEditor.accessibleViewer.previous' }, 'Previous difference'), f1: true });
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
registerAction2(ToggleCollapseUnchangedRegions);

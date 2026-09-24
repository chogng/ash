import { lxiconsLibrary } from '../../../../base/common/lxiconsLibrary.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { Action2, MenuId } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { IEditorService, type EditorInput } from '../../../services/editor/common/editorService.js';
import { MULTI_DIFF_EDITOR_ID } from './multiDiffEditorInput.js';
import { MultiDiffEditorPane } from './multiDiffEditorPane.js';

export const MultiDiffGoToNextChangeCommandId = 'multiDiffEditor.goToNextChange';
export const MultiDiffGoToPreviousChangeCommandId = 'multiDiffEditor.goToPreviousChange';
export const MultiDiffCollapseAllCommandId = 'multiDiffEditor.collapseAll';
export const MultiDiffExpandAllCommandId = 'multiDiffEditor.expandAll';
export const MultiDiffGoToFileCommandId = 'multiDiffEditor.goToFile';

const MultiDiffEditorActive = ActiveEditorContext.isEqualTo(MULTI_DIFF_EDITOR_ID);

export class MultiDiffGoToFileAction extends Action2 {
	constructor() {
		super({
			id: MultiDiffGoToFileCommandId,
			title: 'Open File',
			tooltip: 'Open File',
			icon: lxiconsLibrary.linkExternal,
			precondition: MultiDiffEditorActive,
			menu: { id: MenuId.MultiDiffEditorFileToolbar, when: MultiDiffEditorActive, group: 'navigation', order: 22 },
		});
	}

	public override run(accessor: ServicesAccessor, rawInput: unknown): Promise<void> {
		if (!isEditorInput(rawInput)) throw new TypeError('Open File requires a multi-diff item resource');
		return accessor.get(IEditorService).openEditor(rawInput);
	}
}

export class MultiDiffGoToNextChangeAction extends Action2 {
	constructor() {
		super({
			id: MultiDiffGoToNextChangeCommandId,
			title: 'Go to Next Change',
			tooltip: 'Go to Next Change',
			icon: lxiconsLibrary.arrowDown,
			precondition: MultiDiffEditorActive,
			menu: { id: MenuId.EditorTitle, when: MultiDiffEditorActive, group: 'navigation', order: 11 },
			keybinding: { primary: Keybinding.single(logicalKey('F7')), when: MultiDiffEditorActive },
			f1: true,
		});
	}

	public override run(accessor: ServicesAccessor): void {
		activeMultiDiffPane(accessor)?.nextChange();
	}
}

export class MultiDiffGoToPreviousChangeAction extends Action2 {
	constructor() {
		super({
			id: MultiDiffGoToPreviousChangeCommandId,
			title: 'Go to Previous Change',
			tooltip: 'Go to Previous Change',
			icon: lxiconsLibrary.arrowUp,
			precondition: MultiDiffEditorActive,
			menu: { id: MenuId.EditorTitle, when: MultiDiffEditorActive, group: 'navigation', order: 10 },
			keybinding: { primary: Keybinding.single(logicalKey('F7', { shiftKey: true })), when: MultiDiffEditorActive },
			f1: true,
		});
	}

	public override run(accessor: ServicesAccessor): void {
		activeMultiDiffPane(accessor)?.previousChange();
	}
}

export class MultiDiffCollapseAllAction extends Action2 {
	constructor() {
		super({
			id: MultiDiffCollapseAllCommandId,
			title: 'Collapse All Diffs',
			icon: lxiconsLibrary.fold,
			precondition: MultiDiffEditorActive,
			menu: { id: MenuId.EditorTitle, when: MultiDiffEditorActive, group: '4_collapse', order: 1 },
			f1: true,
		});
	}

	public override run(accessor: ServicesAccessor): void {
		activeMultiDiffPane(accessor)?.collapseAll();
	}
}

export class MultiDiffExpandAllAction extends Action2 {
	constructor() {
		super({
			id: MultiDiffExpandAllCommandId,
			title: 'Expand All Diffs',
			icon: lxiconsLibrary.unfold,
			precondition: MultiDiffEditorActive,
			menu: { id: MenuId.EditorTitle, when: MultiDiffEditorActive, group: '4_collapse', order: 2 },
			f1: true,
		});
	}

	public override run(accessor: ServicesAccessor): void {
		activeMultiDiffPane(accessor)?.expandAll();
	}
}

function activeMultiDiffPane(accessor: ServicesAccessor): MultiDiffEditorPane | undefined {
	const pane = accessor.get(IEditorPart).activePane;
	return pane instanceof MultiDiffEditorPane ? pane : undefined;
}

function isEditorInput(value: unknown): value is EditorInput {
	return typeof value === 'object' && value !== null &&
		'resource' in value &&
		typeof (value as EditorInput).resource?.toString === 'function';
}

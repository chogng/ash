import type { IResourceEditorInput } from '../../../common/editor.js';
import { localize2 } from '../../../../nls.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { Action2, MenuId } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { MULTI_DIFF_EDITOR_ID } from './multiDiffEditorInput.js';
import { MultiDiffEditor } from './multiDiffEditor.js';
import { TextEditorSelectionSource } from '../../../../platform/editor/common/editor.js';

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
			title: localize2({ bundle: 'ash.workbench', key: 'command.MultiDiffGoToFileAction' }, 'Open File'),
			icon: Lxicon.goToFile,
			precondition: MultiDiffEditorActive,
			menu: [MenuId.MultiDiffEditorFileToolbar, MenuId.EditorTitle].map(id => ({ id, when: MultiDiffEditorActive, group: 'navigation', order: 22 })),
		});
	}

	public override run(accessor: ServicesAccessor, rawInput: unknown): Promise<void> {
		if (isEditorInput(rawInput)) {
			return accessor.get(IEditorService).openEditor(rawInput, { pinned: false, revealIfOpened: true });
		}
		const pane = activeMultiDiffPane(accessor, rawInput);
		const item = pane?.getActiveDiffItem();
		if (!item) {
			return Promise.resolve();
		}
		const selection = pane?.getControl()?.modifiedEditor.getSelection();
		return accessor.get(IEditorService).openEditor(item.goToFile ?? item.modified, {
			pinned: false, revealIfOpened: true,
			...(selection ? { selection, selectionSource: TextEditorSelectionSource.JUMP } : {}),
		});
	}
}

export class MultiDiffGoToNextChangeAction extends Action2 {
	constructor() {
		super({
			id: MultiDiffGoToNextChangeCommandId,
			title: localize2({ bundle: 'ash.workbench', key: 'command.NextChangeAction' }, 'Go to Next Change'),
			icon: Lxicon.arrowDown,
			precondition: MultiDiffEditorActive,
			menu: { id: MenuId.EditorTitle, when: MultiDiffEditorActive, group: 'navigation', order: 11 },
			keybinding: { primary: Keybinding.single(logicalKey('F7')), when: MultiDiffEditorActive },
			f1: true,
		});
	}

	public override run(accessor: ServicesAccessor, context?: unknown): Promise<unknown> | undefined {
		return activeMultiDiffPane(accessor, context)?.nextChange();
	}
}

export class MultiDiffGoToPreviousChangeAction extends Action2 {
	constructor() {
		super({
			id: MultiDiffGoToPreviousChangeCommandId,
			title: localize2({ bundle: 'ash.workbench', key: 'command.PreviousChangeAction' }, 'Go to Previous Change'),
			icon: Lxicon.arrowUp,
			precondition: MultiDiffEditorActive,
			menu: { id: MenuId.EditorTitle, when: MultiDiffEditorActive, group: 'navigation', order: 10 },
			keybinding: { primary: Keybinding.single(logicalKey('F7', { shiftKey: true })), when: MultiDiffEditorActive },
			f1: true,
		});
	}

	public override run(accessor: ServicesAccessor, context?: unknown): Promise<unknown> | undefined {
		return activeMultiDiffPane(accessor, context)?.previousChange();
	}
}

export class MultiDiffCollapseAllAction extends Action2 {
	constructor() {
		super({
			id: MultiDiffCollapseAllCommandId,
			title: localize2({ bundle: 'ash.workbench', key: 'command.MultiDiffCollapseAllAction' }, 'Collapse All Diffs'),
			icon: Lxicon.fold,
			precondition: MultiDiffEditorActive,
			menu: { id: MenuId.EditorTitle, when: MultiDiffEditorActive, group: '4_collapse', order: 1 },
			f1: true,
		});
	}

	public override run(accessor: ServicesAccessor, context?: unknown): void {
		activeMultiDiffPane(accessor, context)?.collapseAll();
	}
}

export class MultiDiffExpandAllAction extends Action2 {
	constructor() {
		super({
			id: MultiDiffExpandAllCommandId,
			title: localize2({ bundle: 'ash.workbench', key: 'command.MultiDiffExpandAllAction' }, 'Expand All Diffs'),
			icon: Lxicon.unfold,
			precondition: MultiDiffEditorActive,
			menu: { id: MenuId.EditorTitle, when: MultiDiffEditorActive, group: '4_collapse', order: 2 },
			f1: true,
		});
	}

	public override run(accessor: ServicesAccessor, context?: unknown): void {
		activeMultiDiffPane(accessor, context)?.expandAll();
	}
}

function activeMultiDiffPane(accessor: ServicesAccessor, context?: unknown): MultiDiffEditor | undefined {
	const part = accessor.get(IEditorPart);
	if (typeof context === 'object' && context !== null && 'groupId' in context && typeof context.groupId === 'string') {
		part.activateGroup(context.groupId);
	}
	const pane = part.activePane;
	return pane instanceof MultiDiffEditor ? pane : undefined;
}

function isEditorInput(value: unknown): value is IResourceEditorInput {
	return typeof value === 'object' && value !== null &&
		'resource' in value &&
		typeof (value as IResourceEditorInput).resource?.toString === 'function';
}

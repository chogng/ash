import { localize2 } from '../../../../nls.js';
import { Keybinding, logicalKey } from "../../../../base/common/keybindings.js";
import { Action2, MenuId, registerAction2 } from "../../../../platform/actions/common/actions.js";
import { ContextKeyExpr } from "../../../../platform/contextkey/common/contextkey.js";
import type { ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService } from "../../../../platform/quickinput/common/quickInput.js";
import { ActiveEditorLastInGroupContext, ActiveEditorPinnedContext, ActiveEditorStickyContext, EditorGroupEditorsCountContext, EditorPartModalVisibleContext, EditorTabsFocusContext, EditorsVisibleContext, MultipleEditorsSelectedInGroupContext } from "../../../common/contextkeys.js";
import { IEditorPart } from "./editorPart.js";
import { IEditorGroupsService } from "../../../services/editor/common/editorGroupsService.js";
import { resolveCommandsContext } from "./editorCommandsContext.js";
import { showEditorTypePicker } from "./editorTypePicker.js";
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { URI, type UriComponents } from '../../../../base/common/uri.js';
import { CODE_EDITOR_ID } from '../../../common/editor/codeEditorId.js';

export const CLOSE_EDITOR_COMMAND_ID = "workbench.action.closeActiveEditor";

registerAction2(class CloseActiveEditorAction extends Action2 {
	constructor() {
		super({
			id: CLOSE_EDITOR_COMMAND_ID,
			title: localize2({ bundle: "ash", key: "workbench.closeEditor" }, "Close Editor"),
			f1: true,
			precondition: EditorsVisibleContext.isEqualTo(true),
			menu: [
				{ id: MenuId.MenubarFileMenu, group: "6_close", order: 2 },
				{ id: MenuId.EditorTitleContext, group: "1_close", order: 10 },
			],
			keybinding: { primary: Keybinding.single(logicalKey("w", { primaryKey: true })) },
		});
	}

	override async run(accessor: ServicesAccessor, ...args: readonly unknown[]): Promise<void> {
		const editorPart = accessor.get(IEditorPart);
		if (args.length === 0 && editorPart.getEditorState().isModalEditorVisible && editorPart.activeInput) {
			await editorPart.closeEditor(editorPart.activeInput);
			return;
		}
		const context = resolveCommandsContext(args, accessor.get(IEditorGroupsService));
		for (const { group, editors } of context.groupedEditors) {
			for (const input of editors) {
				if (!await group.closeEditor(input)) {
					return;
				}
			}
		}
	}
});

export const REOPEN_WITH_COMMAND_ID = "workbench.action.reopenWithEditor";

registerAction2(class ReopenWithAction extends Action2 {
	constructor() {
		super({
			id: REOPEN_WITH_COMMAND_ID,
			title: localize2({ bundle: "ash", key: "workbench.reopenWithEditor" }, "Reopen Editor With..."),
			f1: true,
			menu: { id: MenuId.EditorTitleContext, group: '1_open', order: 20, when: EditorsVisibleContext.isEqualTo(true) },
		});
	}

	override run(accessor: ServicesAccessor, context?: unknown): void {
		const groupId = typeof context === 'object' && context !== null && 'groupId' in context && typeof context.groupId === 'string' ? context.groupId : undefined;
		const editorIndex = typeof context === 'object' && context !== null && 'editorIndex' in context && typeof context.editorIndex === 'number' ? context.editorIndex : undefined;
		showEditorTypePicker(accessor.get(IEditorPart), accessor.get(IQuickInputService), groupId, editorIndex);
	}
});

export const REOPEN_ACTIVE_EDITOR_WITH_COMMAND_ID = 'reopenActiveEditorWith';
export const API_OPEN_WITH_EDITOR_COMMAND_ID = '_workbench.openWith';

CommandsRegistry.register(REOPEN_ACTIVE_EDITOR_WITH_COMMAND_ID, async (accessor, override, ...args) => {
	if (typeof override !== 'string') throw new TypeError('Editor override must be a string');
	const part = accessor.get(IEditorPart);
	if (args.length === 0) { await part.reopenActiveEditorWith(override === 'default' ? CODE_EDITOR_ID : override); return; }
	for (const { group, editors } of resolveCommandsContext(args, accessor.get(IEditorGroupsService)).groupedEditors) {
		const owner = part.groups.find(candidate => candidate.id === group.id);
		for (const input of editors) await owner?.openEditor(input, { preferredEditorId: override === 'default' ? CODE_EDITOR_ID : override, pinned: true });
	}
});

CommandsRegistry.register(API_OPEN_WITH_EDITOR_COMMAND_ID, async (accessor, resource, id, columnAndOptions, sourceGroupId) => {
	if (typeof id !== 'string' || typeof resource !== 'object' || resource === null) throw new TypeError('Open With requires a URI and editor ID');
	const uri = URI.from(resource as UriComponents);
	const part = accessor.get(IEditorPart);
	const source = typeof sourceGroupId === 'string' ? part.groups.find(group => group.id === sourceGroupId) : part.activeGroup;
	if (!source) return;
	const matching = source.inputs.filter(input => input.resource.toString() === uri.toString());
	const input = matching.find(input => !input.editorId) ?? matching[0]?.toUntyped?.() ?? { resource: uri };
	const column = Array.isArray(columnAndOptions) ? columnAndOptions[0] : undefined;
	const preferredEditorId = id === 'default' ? CODE_EDITOR_ID : id;
	const descriptor = part.getEditorPaneChoices(input).find(choice => choice.id === preferredEditorId);
	if (!descriptor) throw new RangeError(`No matching editor '${preferredEditorId}'`);
	const opened = descriptor.createInput ? descriptor.createInput(input) : input;
	if (column === -2) {
		source.focus();
		await part.openEditor(opened, { preferredEditorId, pinned: true }, 'sideGroup');
	} else {
		const target = typeof column === 'number' && column > 0 ? part.groups[column - 1] : source;
		await target?.openEditor(opened, { preferredEditorId, pinned: true });
	}
});

export const KEEP_EDITOR_COMMAND_ID = 'workbench.action.keepEditor';
export const PIN_EDITOR_COMMAND_ID = 'workbench.action.pinEditor';
export const UNPIN_EDITOR_COMMAND_ID = 'workbench.action.unpinEditor';
export const CLOSE_OTHER_EDITORS_IN_GROUP_COMMAND_ID = 'workbench.action.closeOtherEditors';

registerAction2(class KeepEditorAction extends Action2 {
	constructor() {
		super({
			id: KEEP_EDITOR_COMMAND_ID,
			title: localize2({ bundle: 'ash', key: 'workbench.keepEditor' }, 'Keep Open'),
			f1: true,
			precondition: ContextKeyExpr.and(EditorsVisibleContext.isEqualTo(true), EditorPartModalVisibleContext.isEqualTo(false), ActiveEditorPinnedContext.isEqualTo(false)),
			menu: { id: MenuId.EditorTitleContext, when: ActiveEditorPinnedContext.isEqualTo(false), group: '3_preview', order: 1 },
			keybinding: { primary: Keybinding.chord(logicalKey('k', { primaryKey: true }), logicalKey('Enter')) },
		});
	}

	override run(accessor: ServicesAccessor, ...args: readonly unknown[]): void {
		for (const { group, editors } of resolveCommandsContext(args, accessor.get(IEditorGroupsService)).groupedEditors) {
			for (const input of editors) {
				group.pinEditor(input);
			}
		}
	}
});

registerAction2(class PinEditorAction extends Action2 {
	constructor() {
		super({
			id: PIN_EDITOR_COMMAND_ID,
			title: localize2({ bundle: 'ash', key: 'workbench.pinEditor' }, 'Pin Editor'),
			f1: true,
			precondition: ContextKeyExpr.and(EditorsVisibleContext.isEqualTo(true), EditorPartModalVisibleContext.isEqualTo(false), ActiveEditorStickyContext.isEqualTo(false)),
			menu: { id: MenuId.EditorTitleContext, when: ActiveEditorStickyContext.isEqualTo(false), group: '3_preview', order: 2 },
			keybinding: [
				{ primary: Keybinding.chord(logicalKey('k', { primaryKey: true }), logicalKey('Enter', { shiftKey: true })) },
				{ primary: Keybinding.single(logicalKey('Enter', { altKey: true })), when: EditorTabsFocusContext.isEqualTo(true) },
			],
		});
	}

	override run(accessor: ServicesAccessor, ...args: readonly unknown[]): void {
		for (const { group, editors } of resolveCommandsContext(args, accessor.get(IEditorGroupsService)).groupedEditors) {
			for (const input of editors) {
				group.stickEditor(input);
			}
		}
	}
});

registerAction2(class UnpinEditorAction extends Action2 {
	constructor() {
		super({
			id: UNPIN_EDITOR_COMMAND_ID,
			title: localize2({ bundle: 'ash', key: 'workbench.unpinEditor' }, 'Unpin Editor'),
			f1: true,
			precondition: ContextKeyExpr.and(EditorsVisibleContext.isEqualTo(true), EditorPartModalVisibleContext.isEqualTo(false), ActiveEditorStickyContext.isEqualTo(true)),
			menu: { id: MenuId.EditorTitleContext, when: ActiveEditorStickyContext.isEqualTo(true), group: '3_preview', order: 2 },
			keybinding: [
				{ primary: Keybinding.chord(logicalKey('k', { primaryKey: true }), logicalKey('Enter', { shiftKey: true })) },
				{ primary: Keybinding.single(logicalKey('Enter', { altKey: true })), when: EditorTabsFocusContext.isEqualTo(true) },
			],
		});
	}

	override run(accessor: ServicesAccessor, ...args: readonly unknown[]): void {
		for (const { group, editors } of resolveCommandsContext(args, accessor.get(IEditorGroupsService)).groupedEditors) {
			for (const input of editors) {
				group.unstickEditor(input);
			}
		}
	}
});

registerAction2(class CloseOtherEditorsAction extends Action2 {
	constructor() {
		super({
			id: CLOSE_OTHER_EDITORS_IN_GROUP_COMMAND_ID,
			title: localize2({ bundle: 'ash', key: 'workbench.closeOtherEditors' }, 'Close Other Editors'),
			f1: true,
			precondition: ContextKeyExpr.and(EditorsVisibleContext.isEqualTo(true), ContextKeyExpr.notEquals(EditorGroupEditorsCountContext.key, 1)),
			menu: { id: MenuId.EditorTitleContext, group: '1_close', order: 20 },
		});
	}

	override async run(accessor: ServicesAccessor, ...args: readonly unknown[]): Promise<void> {
		for (const { group, editors } of resolveCommandsContext(args, accessor.get(IEditorGroupsService)).groupedEditors) {
			for (const input of [...group.inputs]) {
				if (!editors.includes(input) && !group.isSticky(input) && !await group.closeEditor(input)) {
					return;
				}
			}
		}
	}
});

export const CLOSE_EDITORS_TO_THE_RIGHT_COMMAND_ID = 'workbench.action.closeEditorsToTheRight';
export const CLOSE_SAVED_EDITORS_COMMAND_ID = 'workbench.action.closeUnmodifiedEditors';
export const CLOSE_EDITORS_IN_GROUP_COMMAND_ID = 'workbench.action.closeEditorsInGroup';

for (const definition of [
	{ id: CLOSE_EDITORS_TO_THE_RIGHT_COMMAND_ID, key: 'workbench.closeEditorsToTheRight', title: 'Close to the Right', order: 30, precondition: ContextKeyExpr.and(EditorsVisibleContext.isEqualTo(true), ActiveEditorLastInGroupContext.isEqualTo(false), ContextKeyExpr.not(MultipleEditorsSelectedInGroupContext.key)) },
	{ id: CLOSE_SAVED_EDITORS_COMMAND_ID, key: 'workbench.closeSavedEditors', title: 'Close Saved', order: 40, precondition: EditorsVisibleContext.isEqualTo(true) },
	{ id: CLOSE_EDITORS_IN_GROUP_COMMAND_ID, key: 'workbench.closeEditorsInGroup', title: 'Close All in Group', order: 50, precondition: EditorsVisibleContext.isEqualTo(true) },
]) {
	registerAction2(class CloseEditorsInGroupAction extends Action2 {
		constructor() {
			super({
				id: definition.id,
				title: localize2({ bundle: 'ash', key: definition.key }, definition.title),
				f1: true,
				precondition: definition.precondition,
				menu: { id: MenuId.EditorTitleContext, group: '1_close', order: definition.order },
			});
		}

		override async run(accessor: ServicesAccessor, ...args: readonly unknown[]): Promise<void> {
			for (const { group, editors } of resolveCommandsContext(args, accessor.get(IEditorGroupsService)).groupedEditors) {
				if (definition.id === CLOSE_EDITORS_TO_THE_RIGHT_COMMAND_ID && editors.length !== 1) {
					continue;
				}
				const boundary = group.inputs.indexOf(editors[0]!);
				const targets = group.editors.filter(editor => {
					if (editor.isSticky) return false;
					if (definition.id === CLOSE_SAVED_EDITORS_COMMAND_ID) return !editor.isDirty;
					if (definition.id === CLOSE_EDITORS_TO_THE_RIGHT_COMMAND_ID) return editor.index > boundary;
					return true;
				});
				for (const { input } of targets) {
					if (!await group.closeEditor(input)) return;
				}
			}
		}
	});
}

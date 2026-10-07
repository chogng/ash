import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { HierarchicalKind } from '../../../../base/common/hierarchicalKind.js';
import { localize2 } from '../../../../nls.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import {
	EditorAction,
	EditorCommand,
	EditorContributionInstantiation,
	registerEditorAction,
	registerEditorCommand,
	registerEditorContribution,
	type ServicesAccessor,
} from '../../../browser/editorExtensions.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { DefaultTextPasteOrDropEditProvider } from './defaultProviders.js';
import { CopyPasteController, type PastePreference, changePasteTypeCommandId, pasteWidgetVisibleCtx } from './copyPasteController.js';

export const pasteAsCommandId = 'editor.action.pasteAs';

registerEditorContribution(
	CopyPasteController.ID,
	CopyPasteController,
	EditorContributionInstantiation.Eager,
);

registerEditorCommand(new class extends EditorCommand {
	constructor() {
		super({
			id: changePasteTypeCommandId,
			precondition: pasteWidgetVisibleCtx.isEqualTo(true),
			kbOpts: { weight: KeybindingWeight.EditorContrib, primary: KeyMod.CtrlCmd | KeyCode.Period },
		});
	}
	runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		CopyPasteController.get(editor)?.changePasteType();
	}
});

registerEditorAction(class PasteAsAction extends EditorAction {
	constructor() {
		super({
			id: pasteAsCommandId,
			label: localize2('dropOrPaste.pasteAs', 'Paste As...'),
			precondition: EditorContextKeys.writable,
			metadata: {
				description: localize2('dropOrPaste.pasteAs', 'Paste As...'),
				args: [{
					name: 'args',
					isOptional: true,
					schema: {
						type: 'object',
						oneOf: [
							{ required: ['kind'], properties: { kind: { type: 'string' } } },
							{
								required: ['preferences'],
								properties: { preferences: { type: 'array', items: { type: 'string' } } },
							},
						],
					},
				}],
			},
		});
	}
	run(_accessor: ServicesAccessor, editor: ICodeEditor, args: unknown): Promise<void> | undefined {
		let preferred: PastePreference | undefined;
		if (args !== undefined) {
			if (typeof args !== 'object' || args === null || Array.isArray(args)) {
				throw new TypeError('Paste As arguments must be an object');
			}
			if (Object.keys(args).length === 0) {
				return CopyPasteController.get(editor)?.pasteAs();
			}
			if ('kind' in args && typeof args.kind === 'string' && !('preferences' in args)) {
				preferred = { only: new HierarchicalKind(args.kind) };
			} else if ('preferences' in args && Array.isArray(args.preferences)
				&& args.preferences.every(value => typeof value === 'string') && !('kind' in args)) {
				preferred = { preferences: args.preferences.map(value => new HierarchicalKind(value)) };
			} else {
				throw new TypeError('Paste As requires kind or preferences');
			}
		}
		return CopyPasteController.get(editor)?.pasteAs(preferred);
	}
});

registerEditorCommand(new class extends EditorCommand {
	constructor() {
		super({
			id: 'editor.hidePasteWidget',
			precondition: pasteWidgetVisibleCtx.isEqualTo(true),
			kbOpts: { weight: KeybindingWeight.EditorContrib, primary: KeyCode.Escape },
		});
	}
	runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		CopyPasteController.get(editor)?.clearWidgets();
	}
});

registerEditorAction(class PasteAsTextAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.pasteAsText',
			label: localize2('dropOrPaste.pasteAsText', 'Paste as Text'),
			precondition: EditorContextKeys.writable,
		});
	}
	public run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> | undefined {
		return CopyPasteController.get(editor)?.pasteAs({ providerId: DefaultTextPasteOrDropEditProvider.id });
	}
});

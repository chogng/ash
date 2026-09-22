import { KeyCode } from '../../../../base/common/keyCodes.js';
import { localize2 } from '../../../../nls.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorAction2 } from '../../../browser/editorExtensions.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { StickyScrollController } from './stickyScrollController.js';

export class ToggleStickyScroll extends EditorAction2 {
	constructor() {
		super({ id: 'editor.action.toggleStickyScroll', title: localize2('toggleStickyScroll', 'Toggle Editor Sticky Scroll'), f1: true });
	}

	public runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		editor.updateOptions({ stickyScroll: { enabled: !editor.getOption(EditorOption.stickyScroll).enabled } });
	}
}

export class FocusStickyScroll extends EditorAction2 {
	constructor() {
		super({
			id: 'editor.action.focusStickyScroll',
			title: localize2('focusStickyScroll', 'Focus Editor Sticky Scroll'),
			precondition: EditorContextKeys.stickyScrollVisible.isEqualTo(true),
			f1: true,
		});
	}

	public runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		StickyScrollController.get(editor)?.focus();
	}
}

export class SelectNextStickyScrollLine extends EditorAction2 {
	constructor() {
		super({
			id: 'editor.action.selectNextStickyScrollLine',
			title: localize2('nextStickyScrollLine', 'Select the Next Sticky Scroll Line'),
			precondition: EditorContextKeys.stickyScrollFocused.isEqualTo(true),
			keybinding: { weight: KeybindingWeight.EditorContrib, primary: KeyCode.DownArrow },
		});
	}

	public runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		StickyScrollController.get(editor)?.focusNext();
	}
}

export class SelectPreviousStickyScrollLine extends EditorAction2 {
	constructor() {
		super({
			id: 'editor.action.selectPreviousStickyScrollLine',
			title: localize2('previousStickyScrollLine', 'Select the Previous Sticky Scroll Line'),
			precondition: EditorContextKeys.stickyScrollFocused.isEqualTo(true),
			keybinding: { weight: KeybindingWeight.EditorContrib, primary: KeyCode.UpArrow },
		});
	}

	public runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		StickyScrollController.get(editor)?.focusPrevious();
	}
}

export class GoToStickyScrollLine extends EditorAction2 {
	constructor() {
		super({
			id: 'editor.action.goToFocusedStickyScrollLine',
			title: localize2('goToStickyScrollLine', 'Go to the Focused Sticky Scroll Line'),
			precondition: EditorContextKeys.stickyScrollFocused.isEqualTo(true),
			keybinding: { weight: KeybindingWeight.EditorContrib, primary: KeyCode.Enter },
		});
	}

	public runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		StickyScrollController.get(editor)?.goToFocused();
	}
}

export class SelectEditor extends EditorAction2 {
	constructor() {
		super({
			id: 'editor.action.selectEditor',
			title: localize2('selectEditor', 'Select Editor'),
			precondition: EditorContextKeys.stickyScrollFocused.isEqualTo(true),
			keybinding: { weight: KeybindingWeight.EditorContrib, primary: KeyCode.Escape },
		});
	}

	public runEditorCommand(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		StickyScrollController.get(editor)?.selectEditor();
	}
}

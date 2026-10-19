import { KeyCode } from '../../../../../../src/ash/base/common/keyCodes.js';
import { localize2 } from '../../../../../../src/ash/nls.js';
import { KeybindingWeight } from '../../../../../../src/ash/platform/keybinding/common/keybindingsRegistry.js';
import type { ServicesAccessor } from '../../../../../../src/ash/platform/instantiation/common/instantiation.js';
import type { ICodeEditor } from '../../../../../../src/ash/editor/browser/editorBrowser.js';
import { EditorAction2 } from '../../../registration.js';
import { EditorOption } from '../../../../../../src/ash/editor/common/config/editorOptions.js';
import { EditorContextKeys } from '../../../../../../src/ash/editor/common/editorContextKeys.js';
import { StickyScrollController } from './stickyScrollController.js';
import { MenuId } from '../../../../../../src/ash/platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../../src/ash/platform/contextkey/common/contextkey.js';

export class ToggleStickyScroll extends EditorAction2 {
	constructor() {
		super({
			id: 'editor.action.toggleStickyScroll',
			title: localize2('toggleStickyScroll', 'Toggle Editor Sticky Scroll'),
			f1: true,
			toggled: ContextKeyExpr.equals('config.editor.stickyScroll.enabled', true),
			menu: { id: MenuId.StickyScrollContext },
		});
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

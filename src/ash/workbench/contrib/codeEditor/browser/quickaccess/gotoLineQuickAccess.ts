import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { parseStanzaGotoLocation } from '../../../../../editor/contrib/quickAccess/common/gotoLocation.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { TextEditorSelectionSource } from '../../../../../platform/editor/common/editor.js';
import { IQuickAccessController, QuickAccessRegistry, type IQuickAccessProvider } from '../../../../../platform/quickinput/common/quickAccess.js';
import type { IQuickPick, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { EditorsVisibleContext } from '../../../../common/contextkeys.js';

export class GotoLineQuickAccessProvider implements IQuickAccessProvider {
	static readonly GO_TO_LINE_PREFIX = ':';

	constructor(@ICodeEditorService private readonly codeEditorService: ICodeEditorService) { }

	provide(picker: IQuickPick<IQuickPickItem>): DisposableStore {
		const resources = new DisposableStore();
		// Capture the focused diff side before Quick Access takes keyboard focus.
		const editor = this.codeEditorService.getFocusedCodeEditor() ?? this.codeEditorService.getActiveCodeEditor();
		const model = editor?.getModel();
		picker.sortByLabel = false;
		if (!editor || !model) {
			picker.items = [{
				label: localize('gotoLineQuickAccess.noEditor', 'Open a text editor to go to a line or column.'),
				alwaysShow: true,
			}];
			return resources;
		}

		const initialState = editor.saveViewState();
		let accepted = false;
		const isCurrent = (): boolean => this.codeEditorService.listCodeEditors().includes(editor)
			&& editor.getModel() === model && !model.isDisposed();
		resources.add(toDisposable(() => {
			if (!accepted && isCurrent()) editor.restoreViewState(initialState);
		}));
		const update = (): void => {
			if (!isCurrent()) return;
			const result = parseStanzaGotoLocation(model, picker.value);
			if (result.kind === 'location') {
				const { lineNumber, column } = result.location.position;
				picker.items = [{
					label: localize('gotoLineQuickAccess.location', 'Press Enter to go to line {0}, column {1}.', lineNumber, column),
					alwaysShow: true,
				}];
				editor.revealRange(Range.fromPositions(result.location.position));
			} else {
				picker.items = [{
					label: picker.value.startsWith('::')
						? localize('gotoLineQuickAccess.offsetPrompt', 'Type a character offset from 1 to {0}.', model.getValueLength())
						: localize('gotoLineQuickAccess.linePrompt', 'Type a line number from 1 to {0} and an optional column.', model.getLineCount()),
					alwaysShow: true,
				}];
			}
		};
		resources.add(picker.onDidChangeValue(update));
		resources.add(model.onDidChangeContent(update));
		resources.add(editor.onDidChangeModel(() => picker.hide()));
		resources.add(editor.onDidDispose(() => picker.hide()));
		resources.add(model.onWillDispose(() => picker.hide()));
		resources.add(picker.onDidAccept(() => {
			if (!isCurrent()) return;
			const result = parseStanzaGotoLocation(model, picker.value);
			if (result.kind !== 'location') return;
			accepted = true;
			const range = Range.fromPositions(result.location.position);
			editor.setSelection(range, TextEditorSelectionSource.JUMP);
			editor.revealRange(range);
			picker.hide();
			editor.focus();
		}));
		update();
		return resources;
	}
}

class GotoLineAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.gotoLine',
			get title() { return localize2('gotoLine', 'Go to Line/Column...'); },
			f1: true,
			menu: { id: MenuId.MenubarGoMenu, when: EditorsVisibleContext.isEqualTo(true), group: '2_navigation', order: 1 },
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IQuickAccessController).show(GotoLineQuickAccessProvider.GO_TO_LINE_PREFIX);
	}
}

registerAction2(GotoLineAction);

QuickAccessRegistry.register({
	prefix: GotoLineQuickAccessProvider.GO_TO_LINE_PREFIX,
	get placeholder() { return localize('gotoLineQuickAccess.placeholder', 'Type a line number and optional column (e.g. :42:5), or ::1024 for a character offset. Negative values count backwards.'); },
	get helpLabel() { return localize('status.editor.gotoLine', 'Go to Line/Column'); },
	ctor: GotoLineQuickAccessProvider,
});

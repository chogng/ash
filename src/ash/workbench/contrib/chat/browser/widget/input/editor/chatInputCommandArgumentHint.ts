import { status } from '../../../../../../../base/browser/ui/aria/aria.js';
import { Disposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import type { ICodeEditor } from '../../../../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../../../../editor/common/config/editorOptions.js';
import { Range } from '../../../../../../../editor/common/core/range.js';
import { InjectedTextCursorStops, TrackedRangeStickiness } from '../../../../../../../editor/common/model.js';
import { localize } from '../../../../../../../nls.js';
import type { SlashCommandCatalog } from '../../../../common/slashCommands.js';
import { getRangeForPlaceholder } from './chatInputPlaceholderDecoration.js';

/** Projects catalog metadata into the owning input without inserting draft text. */
export class InputEditorCommandArgumentHint extends Disposable {
	public static readonly ID = 'inputEditorCommandArgumentHint';
	private readonly decorations;
	private hint: string | undefined;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly catalog: SlashCommandCatalog,
	) {
		super();
		this.decorations = editor.createDecorationsCollection();
		this._register(toDisposable(() => this.decorations.clear()));
		this._register(editor.onDidChangeModel(() => this.update()));
		this._register(editor.onDidChangeModelContent(() => this.update()));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.readOnly)) this.update();
		}));
		this._register(catalog.onDidChange(() => this.update()));
		this._register(editor.onDidFocusEditorText(() => {
			if (this.hint) this.announceHint(this.hint);
		}));
		this.update();
	}

	private update(): void {
		const model = this.editor.getModel();
		const match = model && !this.editor.getOption(EditorOption.readOnly)
			? /^(\s*)\/([a-z0-9-]+)[ \t]+$/u.exec(model.getValue()) : null;
		const command = match ? this.catalog.get(match[2]!) : undefined;
		const hint = command?.argumentMode === 'optional' ? command.argumentHint?.trim() : undefined;
		const previous = this.hint;
		this.hint = hint;
		if (!model || !match || !hint) {
			this.decorations.clear();
			return;
		}
		const prefix = Range.fromPositions(
			model.getPositionAt(match[1]!.length),
			model.getPositionAt(match[1]!.length + command!.name.length + 1),
		);
		this.decorations.set([{
			range: model.validateRange(getRangeForPlaceholder(prefix)),
			options: {
				description: InputEditorCommandArgumentHint.ID,
				stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
				after: {
					content: hint,
					inlineClassName: 'ash-chat-command-argument-hint',
					cursorStops: InjectedTextCursorStops.None,
				},
			},
		}]);
		if (hint !== previous && this.editor.hasTextFocus()) this.announceHint(hint);
	}

	private announceHint(hint: string): void {
		status(localize('chat.input.commandArguments', 'Command arguments: {0}', hint));
	}
}

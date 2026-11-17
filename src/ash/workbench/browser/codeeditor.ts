import { h } from '../../base/browser/dom.js';
import { Button } from '../../base/browser/ui/button/button.js';
import { getKeybindingLabel } from '../../base/common/keybindingLabels.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { extUri } from '../../base/common/resources.js';
import type { URI } from '../../base/common/uri.js';
import { getCodeEditor, OverlayWidgetPositionPreference, type ICodeEditor, type IOverlayWidget, type IOverlayWidgetPosition } from '../../editor/browser/editorBrowser.js';
import type { IRange } from '../../editor/common/core/range.js';
import { CursorChangeReason } from '../../editor/common/cursorEvents.js';
import { TrackedRangeStickiness } from '../../editor/common/model.js';
import { localize } from '../../nls.js';
import { IKeybindingService } from '../../platform/keybinding/common/keybinding.js';
import { defaultButtonStyles } from '../../platform/theme/browser/defaultStyles.js';
import { IEditorService } from '../services/editor/common/editorService.js';

export interface IRangeHighlightDecoration {
	readonly resource: URI;
	readonly range: IRange;
	readonly isWholeLine?: boolean;
}

/** Holds one transient highlight owned by the navigation source. */
export class RangeHighlightDecorations extends Disposable {
	private readonly highlight = this._register(new MutableDisposable<DisposableStore>());

	constructor(@IEditorService private readonly editorService: IEditorService) {
		super();
	}

	removeHighlightRange(): void {
		this.highlight.clear();
	}

	highlightRange({ resource, range, isWholeLine = true }: IRangeHighlightDecoration, control?: unknown): void {
		this.removeHighlightRange();
		if (this.isDisposed) return;

		const editor = getCodeEditor(control ?? this.editorService.activeEditorPane?.getControl?.());
		const model = editor?.getModel();
		if (!editor || !model || !extUri.isEqual(model.uri, resource)) return;

		const lifetime = new DisposableStore();
		this.highlight.value = lifetime;
		const decorations = editor.createDecorationsCollection();
		lifetime.add(toDisposable(() => decorations.clear()));
		lifetime.add(editor.onWillChangeModel(() => this.removeHighlightRange()));
		lifetime.add(editor.onDidDispose(() => this.removeHighlightRange()));
		lifetime.add(editor.onDidChangeCursorPosition(({ reason }) => {
			if (reason === CursorChangeReason.NotSet || reason === CursorChangeReason.Explicit
				|| reason === CursorChangeReason.Undo || reason === CursorChangeReason.Redo) {
				this.removeHighlightRange();
			}
		}));
		decorations.set([{
			range,
			options: {
				description: 'workbench-range-highlight',
				className: 'rangeHighlight',
				stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
				isWholeLine,
			},
		}]);
	}
}

/** A single editor action positioned by the editor's overlay layout. */
export class FloatingEditorClickWidget extends Disposable implements IOverlayWidget {
	private readonly element: HTMLDivElement;
	private readonly attachment = this._register(new MutableDisposable());
	readonly onClick;

	constructor(
		private readonly editor: ICodeEditor,
		label: string,
		keybindingAction: string | null,
		@IKeybindingService keybindings: IKeybindingService,
	) {
		super();
		this.element = h(editor.getDomNode()!.ownerDocument, 'div');
		const shortcut = keybindingAction ? keybindings.lookupKeybinding(keybindingAction) : undefined;
		const button = this._register(new Button(this.element, {
			...defaultButtonStyles,
			label,
			title: shortcut ? localize({ bundle: 'ash.workbench', key: 'floatingEditorClickWidget.title' }, '{0} ({1})', label, getKeybindingLabel(shortcut)) : undefined,
			presentation: 'secondary',
			size: 'small',
		}));
		this.onClick = button.onDidClick;
		this._register(editor.onDidDispose(() => this.dispose()));
	}

	getId(): string {
		return 'editor.overlayWidget.floatingClickWidget';
	}

	getDomNode(): HTMLElement {
		return this.element;
	}

	getPosition(): IOverlayWidgetPosition {
		return { preference: OverlayWidgetPositionPreference.BOTTOM_RIGHT_CORNER };
	}

	render(): void {
		if (this.isDisposed || this.attachment.value) return;
		this.editor.addOverlayWidget(this);
		this.attachment.value = toDisposable(() => this.editor.removeOverlayWidget(this));
	}
}

import type { IDimension } from '../../../../base/browser/dom.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { constObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import type { AccessibleContentProvider, AccessibleViewType } from '../../../../platform/accessibility/browser/accessibleView.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { CanvasInput, ICanvasService } from '../common/canvas.js';
import { CanvasView } from './canvasView.js';

/** The editor owns its tab lifetime; CanvasView borrows the service's live page. */
export class CanvasEditor extends EditorPane {
	readonly id = CanvasInput.EDITOR_ID;
	private view!: CanvasView;
	private readonly inputLifetime = this._register(new MutableDisposable());

	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ICanvasService private readonly canvases: ICanvasService,
		@IThemeService themes: IThemeService,
		@IStorageService storage: IStorageService,
	) {
		super(CanvasInput.EDITOR_ID, themes, storage);
	}

	override create(parent: HTMLElement): void {
		this.view = this._register(this.instantiation.createInstance(CanvasView, parent, parent.ownerDocument.defaultView!, {
			logPrefix: '[CanvasEditor]',
			notPresentableMessage: constObservable(localize('canvas.hiddenOwner', 'Open this Canvas’s conversation to view its content.')),
			getHelpContent: () => localize('canvas.help', 'This Canvas is an interactive page owned by its conversation. Tab moves through page controls. Use <keybinding:workbench.action.focusNextPart> to leave the page. Closing the tab hides the Canvas. Use <keybinding:workbench.action.chat.reopenCanvas> to reopen it. Close Canvas ends the page. Escape closes this accessible view and returns focus to the Canvas.'),
		}));
		super.create(this.view.element);
	}

	async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.clearInput();
		if (!(input instanceof CanvasInput) || signal.aborted || !this.canvases.isOwnerPresentable(input.reference)) { throw new CancellationError(); }
		this.view.setInput({ reference: input.reference, canvas: input.canvas, membershipPending: constObservable(false) });
		this.inputLifetime.value = addDisposableListener(signal, 'abort', () => this.clearInput());
	}

	clearInput(): void {
		this.inputLifetime.clear();
		this.view?.clearInput();
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.view?.setVisible(visible);
	}

	layout(_dimension: IDimension): void { this.view?.layout(); }
	focus(): void { this.view.focus(); }

	createAccessibleProvider(type: AccessibleViewType): AccessibleContentProvider {
		return this.view.createAccessibleProvider(type);
	}

	protected override disposeCore(): void { this.clearInput(); super.disposeCore(); }
}

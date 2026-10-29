import './media/sessionCanvas.css';
import { h, type IDimension } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import {
	AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService,
} from '../../../../platform/accessibility/browser/accessibleView.js';
import { IBrowserViewService } from '../../../../platform/browserView/common/browserView.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import type { IBrowserViewModel } from '../../browserView/common/browserView.js';
import { WebContentsViewHost } from '../../browserView/electron-browser/webContentsViewHost.js';
import { CanvasInput, ICanvasContextService, ICanvasService } from '../common/canvas.js';

export const SessionCanvasFocusedContext = new RawContextKey<boolean>('sessionCanvasFocused', false);

/** Borrows the service's live page; pane disposal only detaches native presentation. */
export class CanvasEditor extends EditorPane {
	readonly id = CanvasInput.EDITOR_ID;
	private viewport!: HTMLElement;
	private message!: HTMLElement;
	private host!: WebContentsViewHost;
	private input: CanvasInput | undefined;
	private model: IBrowserViewModel | undefined;
	private inputSignal: AbortSignal | undefined;
	private resolving: Promise<void> | undefined;
	private resolutionError: string | undefined;
	private readonly inputLifetime = this._register(new DisposableStore());
	private visible = false;
	private revision = 0;

	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ICanvasService private readonly canvases: ICanvasService,
		@ICanvasContextService contexts: ICanvasContextService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessible: IAccessibleViewService,
		@IBrowserViewService private readonly pages: IBrowserViewService,
		@IThemeService themes: IThemeService,
		@IStorageService storage: IStorageService,
	) {
		super(CanvasInput.EDITOR_ID, themes, storage);
		this._register(contexts.onDidChangeVisibility(() => this.updatePresentation()));
	}

	override create(parent: HTMLElement): void {
		const root = h(parent.ownerDocument, 'section', { className: 'ash-session-canvas' });
		this.viewport = h(parent.ownerDocument, 'div', { className: 'ash-session-canvas-page', attributes: { tabindex: '0', role: 'region' } });
		this.message = h(parent.ownerDocument, 'p', { className: 'ash-session-canvas-message', attributes: { role: 'status' } });
		root.append(this.viewport, this.message);
		parent.append(root);
		super.create(root);
		SessionCanvasFocusedContext.bindTo(this._register(this.contextKeys.createScoped(root))).set(true);
		this.host = this._register(this.instantiation.createInstance(WebContentsViewHost, parent.ownerDocument.defaultView!));
		this.host.onContainerCreated(this.viewport);
	}

	async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.clearInput();
		if (!(input instanceof CanvasInput) || !this.canvases.isOwnerPresentable(input.reference)) { throw new CancellationError(); }
		this.input = input;
		this.inputSignal = signal;
		this.inputLifetime.add(input.canvas.onDidChange(() => { this.resolutionError = undefined; this.updatePresentation(); }));
		// A working set may restore an admitted identity before its provider confirms a source.
		await this.resolveModel();
		this.updatePresentation();
	}

	private resolveModel(): Promise<void> {
		if (this.resolving) { return this.resolving; }
		const input = this.input;
		const source = input?.canvas.get().source;
		const signal = this.inputSignal;
		if (!input || !source || !signal || signal.aborted || this.model || !this.canvases.isOwnerPresentable(input.reference)) { return Promise.resolve(); }
		const revision = this.revision;
		const resolving = (async () => {
			const { model } = await this.canvases.resolveCanvasModel(input.reference, source);
			if (signal.aborted || revision !== this.revision) { throw new CancellationError(); }
			this.model = model;
			this.host.setModel(model);
			this.inputLifetime.add(model.onDidChangeState(() => this.updatePresentation()));
			this.inputLifetime.add(model.onDidEvent(event => {
				if (event.type === 'keyDown' && this.host.isActive) { this.viewport.dispatchEvent(new KeyboardEvent('keydown', { ...event.event, bubbles: true, cancelable: true })); }
			}));
			this.updatePresentation();
		})().finally(() => { if (this.resolving === resolving) { this.resolving = undefined; } });
		this.resolving = resolving;
		return resolving;
	}

	clearInput(): void {
		this.revision++;
		this.inputLifetime.clear();
		this.input = undefined;
		this.model = undefined;
		this.inputSignal = undefined;
		this.resolving = undefined;
		this.resolutionError = undefined;
		this.host?.setModel(undefined);
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.visible = visible;
		this.updatePresentation();
	}

	private updatePresentation(): void {
		if (!this.host) { return; }
		const available = !!this.input && this.canvases.isOwnerPresentable(this.input.reference);
		const error = this.resolutionError ?? this.model?.state.errorDescription;
		if (available && !this.model && !this.resolving && !error && this.input?.canvas.get().source) {
			void this.resolveModel().catch(error => {
				if (!this.isDisposed && !(error instanceof CancellationError)) { this.resolutionError = String(error); this.updatePresentation(); }
			});
		}
		const pending = !this.input?.canvas.get().source || !this.model;
		this.host.setVisible(this.visible && available && !!this.model && !error && !pending);
		this.message.hidden = available && !error && !pending;
		this.message.textContent = !available ? localize('canvas.hiddenOwner', 'Open this Canvas’s conversation to view its content.')
			: error ? localize('canvas.pageFailed', 'This Canvas could not load: {0}', error) : pending ? localize('canvas.waitingSource', 'This Canvas is reconnecting…') : '';
		this.viewport.setAttribute('aria-label', localize('canvas.pageLabel', 'Canvas: {0}', this.input?.getName() ?? ''));
	}

	layout(_dimension: IDimension): void { this.host?.layout(); }
	focus(): void {
		if (!this.input || !this.canvases.isOwnerPresentable(this.input.reference)) { return; }
		this.viewport.focus();
		this.host.tryFocus();
		const hint = this.accessible.getOpenAriaHint(AccessibilityVerbositySettingId.SessionCanvas);
		if (hint) { status(hint); }
	}

	createAccessibleProvider(type: AccessibleViewType): AccessibleContentProvider {
		const input = this.input;
		const model = this.model;
		const source = input?.canvas.get().source;
		let closed = false;
		let text = type === AccessibleViewType.Help
			? localize('canvas.help', 'This Canvas is an interactive page owned by its conversation. Tab moves through page controls. Use <keybinding:workbench.action.focusNextPart> to leave the page. Closing the tab hides the Canvas. Use <keybinding:workbench.action.chat.reopenCanvas> to reopen it. Close Canvas ends the page. Escape closes this accessible view and returns focus to the Canvas.')
			: localize('canvas.reading', 'Reading Canvas content…');
		const changed = new Emitter<void>();
		const provider = new AccessibleContentProvider(AccessibleViewProviderId.SessionCanvas, { type }, () => text, () => {
			closed = true;
			changed.dispose();
			if (input === this.input && !this.isDisposed) { this.focus(); }
		}, AccessibilityVerbositySettingId.SessionCanvas);
		provider.onDidChangeContent = changed.event;
		if (type === AccessibleViewType.View && input && source && model && this.canvases.isOwnerPresentable(input.reference)) {
			void this.pages.getAccessibilityTree(model.id).then(result => {
				if (closed || input !== this.input || input.canvas.get().source?.toString() !== source.toString() || !this.canvases.isOwnerPresentable(input.reference)) { return; }
				text = result || localize('canvas.noAccessibleContent', 'This page has no accessible content.');
				changed.fire();
			}, () => {
				if (!closed) { text = localize('canvas.readFailed', 'Could not read this Canvas. Return to its conversation and try again.'); changed.fire(); }
			});
		} else if (type === AccessibleViewType.View && !source) { text = localize('canvas.waitingSource', 'This Canvas is reconnecting…'); }
		return provider;
	}

	protected override disposeCore(): void { this.clearInput(); super.disposeCore(); }
}

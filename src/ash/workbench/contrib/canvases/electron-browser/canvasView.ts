import './media/sessionCanvas.css';
import { h } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { encodeBase64 } from '../../../../base/common/buffer.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, type IObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import {
	AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService,
} from '../../../../platform/accessibility/browser/accessibleView.js';
import { IBrowserViewService } from '../../../../platform/browserView/common/browserView.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { IBrowserViewModel } from '../../browserView/common/browserView.js';
import { WebContentsViewHost } from '../../browserView/electron-browser/webContentsViewHost.js';
import { ICanvasContextService, ICanvasService, type ICanvas, type ICanvasReference } from '../common/canvas.js';

export const SessionCanvasFocusedContext = new RawContextKey<boolean>('sessionCanvasFocused', false);

export interface ICanvasViewInput {
	readonly reference: ICanvasReference;
	readonly canvas: IObservable<ICanvas | undefined>;
	readonly membershipPending: IObservable<boolean>;
}

export interface ICanvasViewOptions {
	readonly logPrefix: string;
	readonly notPresentableMessage: IObservable<string>;
	readonly getHelpContent: () => string;
}

const views = new Set<CanvasView>();

/** Accessibility follows the focused surface, including a view outside the active editor. */
export function getFocusedCanvasView(): CanvasView | undefined {
	return [...views].find(view => view.element.contains(view.element.ownerDocument.activeElement));
}

/** Borrows a service-owned page. WebContentsViewHost owns native geometry and split-view arbitration. */
export class CanvasView extends Disposable {
	readonly element: HTMLElement;
	private readonly viewport: HTMLElement;
	private readonly message: HTMLElement;
	private readonly heldFrame: HTMLImageElement;
	private readonly host: WebContentsViewHost;
	private readonly inputLifetime = this._register(new DisposableStore());
	private readonly modelLifetime = this._register(new DisposableStore());
	private readonly frameLifetime = this._register(new MutableDisposable());
	private currentInput: ICanvasViewInput | undefined;
	private model: IBrowserViewModel | undefined;
	private resolving: Promise<void> | undefined;
	private resolutionError: string | undefined;
	private resolutionCancelled = false;
	private visible = false;
	private presenting = false;
	private revision = 0;
	private frameRevision = 0;

	constructor(
		parent: HTMLElement,
		targetWindow: Window & typeof globalThis,
		private readonly options: ICanvasViewOptions,
		@IInstantiationService instantiation: IInstantiationService,
		@ICanvasService private readonly canvases: ICanvasService,
		@ICanvasContextService contexts: ICanvasContextService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessible: IAccessibleViewService,
		@IBrowserViewService private readonly pages: IBrowserViewService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		const document = parent.ownerDocument;
		this.element = h(document, 'section', { className: 'ash-session-canvas' });
		this.viewport = h(document, 'div', { className: 'ash-session-canvas-page', attributes: { tabindex: '0', role: 'region' } });
		this.message = h(document, 'p', { className: 'ash-session-canvas-message', attributes: { role: 'status' } });
		this.heldFrame = h(document, 'img', { className: 'ash-session-canvas-held-frame', attributes: { alt: '', 'aria-hidden': 'true' } });
		this.heldFrame.hidden = true;
		this.element.append(this.viewport, this.message, this.heldFrame);
		parent.append(this.element);
		SessionCanvasFocusedContext.bindTo(this._register(contextKeys.createScoped(this.element))).set(true);
		this.host = this._register(instantiation.createInstance(WebContentsViewHost, targetWindow));
		this.host.onContainerCreated(this.viewport);
		this._register(contexts.onDidChangeVisibility(() => this.updatePresentation()));
		views.add(this);
		this._register(toDisposable(() => {
			views.delete(this);
			this.element.remove();
		}));
		this.updatePresentation();
	}

	get input(): ICanvasViewInput | undefined { return this.currentInput; }

	setInput(input: ICanvasViewInput | undefined): void {
		if (input === this.currentInput) { return; }
		this.holdFrame();
		this.revision++;
		this.inputLifetime.clear();
		this.modelLifetime.clear();
		this.host.setVisible(false);
		this.host.setModel(undefined);
		this.presenting = false;
		this.model = undefined;
		this.resolving = undefined;
		this.resolutionError = undefined;
		this.resolutionCancelled = false;
		this.currentInput = input;
		if (input) {
			this.inputLifetime.add(autorun(reader => {
				input.canvas.read(reader);
				input.membershipPending.read(reader);
				this.canvases.enabled.read(reader);
				this.options.notPresentableMessage.read(reader);
				this.resolutionError = undefined;
				this.resolutionCancelled = false;
				this.updatePresentation();
			}));
		} else {
			this.updatePresentation();
		}
	}

	/** Keep the switch frame across the editor host's clear-then-set sequence. */
	clearInput(): void { this.setInput(undefined); }

	setVisible(visible: boolean): void {
		this.visible = visible;
		if (!visible) { this.releaseFrame(); }
		this.updatePresentation();
	}

	layout(): void { this.host.layout(); }

	private resolveModel(): void {
		const input = this.currentInput;
		const source = input?.canvas.get()?.source;
		if (!input || !source || this.model || this.resolving) { return; }
		const revision = this.revision;
		const resolving = Promise.resolve().then(async () => {
			try {
				const { model } = await this.canvases.resolveCanvasModel(input.reference, source);
				if (this.isDisposed || revision !== this.revision || input.canvas.get()?.source?.toString() !== source.toString()
					|| input.membershipPending.get() || !this.canvases.isPresentable(input.reference)) {
					throw new CancellationError();
				}
				this.model = model;
				this.host.setModel(model);
				this.modelLifetime.add(model.onDidChangeState(() => this.updatePresentation()));
				this.modelLifetime.add(model.onDidEvent(event => {
					if (event.type === 'keyDown' && this.host.isActive) {
						const KeyboardEvent = this.viewport.ownerDocument.defaultView!.KeyboardEvent;
						this.viewport.dispatchEvent(new KeyboardEvent('keydown', { ...event.event, bubbles: true, cancelable: true }));
					}
				}));
			} catch (error) {
				if (revision === this.revision && input.canvas.get()?.source?.toString() === source.toString() && isCancellationError(error)) {
					this.resolutionCancelled = true;
				}
				if (!this.isDisposed && revision === this.revision && input.canvas.get()?.source?.toString() === source.toString() && !isCancellationError(error)) {
					this.resolutionError = String(error);
					this.log.error(this.options.logPrefix, 'Could not resolve Canvas', error);
				}
			}
		}).finally(() => {
			if (this.resolving === resolving) {
				this.resolving = undefined;
				if (!this.isDisposed) { this.updatePresentation(); }
			}
		});
		this.resolving = resolving;
	}

	private updatePresentation(): void {
		const input = this.currentInput;
		const canvas = input?.canvas.get();
		const available = !!input && this.canvases.enabled.get() && this.canvases.isPresentable(input.reference);
		const pending = input?.membershipPending.get() || !canvas?.source;
		const error = this.resolutionError ?? this.model?.state.errorDescription;
		if (available && !pending && !error && !this.resolutionCancelled) { this.resolveModel(); }
		const show = this.visible && available && !pending && !!this.model && !error;
		if (show !== this.presenting) {
			this.presenting = show;
			this.host.setVisible(show);
			// Recovery may restore native focus only while this surface still has workbench focus.
			if (show && this.element.contains(this.element.ownerDocument.activeElement)) { this.host.tryFocus(); }
		}
		if (input && !available) { this.releaseFrame(); }
		if (show && this.host.isActive && this.model?.state.visible && !this.heldFrame.hidden) {
			this.frameLifetime.value = disposableTimeout(() => this.releaseFrame(), 100);
		}
		this.message.hidden = !input || available && !error && !pending && !!this.model;
		this.message.textContent = !input ? '' : !available ? this.options.notPresentableMessage.get()
			: error ? localize('canvas.pageFailed', 'This Canvas could not load: {0}', error)
				: localize('canvas.waitingSource', 'This Canvas is reconnecting…');
		this.viewport.setAttribute('aria-label', localize('canvas.pageLabel', 'Canvas: {0}', canvas?.title ?? ''));
	}

	private holdFrame(): void {
		if (this.isDisposed || !this.presenting || !this.host.isActive || !this.model?.state.visible) { return; }
		this.releaseFrame();
		const revision = this.frameRevision;
		// Capture the page before detaching it. Late captures cannot cover a new presentation or owner.
		this.frameLifetime.value = disposableTimeout(() => this.releaseFrame(), 300);
		void this.model.captureScreenshot({ format: 'png' }).then(frame => {
			if (this.isDisposed || revision !== this.frameRevision || !this.visible) { return; }
			if (this.presenting && this.host.isActive && this.model?.state.visible) { this.releaseFrame(); return; }
			this.heldFrame.src = `data:image/png;base64,${encodeBase64(frame)}`;
			this.heldFrame.hidden = false;
		}, () => { if (revision === this.frameRevision) { this.releaseFrame(); } });
	}

	private releaseFrame(): void {
		this.frameRevision++;
		this.frameLifetime.clear();
		this.heldFrame.hidden = true;
		this.heldFrame.removeAttribute('src');
	}

	focus(): void {
		if (!this.currentInput || !this.canvases.isPresentable(this.currentInput.reference)) { return; }
		this.viewport.focus();
		this.host.tryFocus();
		const hint = this.accessible.getOpenAriaHint(AccessibilityVerbositySettingId.SessionCanvas);
		if (hint) { status(hint); }
	}

	createAccessibleProvider(type: AccessibleViewType): AccessibleContentProvider {
		const input = this.currentInput;
		const source = input?.canvas.get()?.source;
		const model = this.model;
		const revision = this.revision;
		let closed = false;
		let text = type === AccessibleViewType.Help ? this.options.getHelpContent() : localize('canvas.reading', 'Reading Canvas content…');
		const changed = new Emitter<void>();
		const provider = new AccessibleContentProvider(AccessibleViewProviderId.SessionCanvas, { type }, () => text, () => {
			closed = true;
			changed.dispose();
			if (input === this.currentInput && !this.isDisposed) { this.focus(); }
		}, AccessibilityVerbositySettingId.SessionCanvas);
		provider.onDidChangeContent = changed.event;
		const isCurrent = () => !closed && !this.isDisposed && revision === this.revision && !!input
			&& input.canvas.get()?.source?.toString() === source?.toString() && this.canvases.isPresentable(input.reference);
		if (type === AccessibleViewType.View && input && source && model && isCurrent()) {
			void this.pages.getAccessibilityTree(model.id).then(result => {
				if (!isCurrent()) { return; }
				text = result || localize('canvas.noAccessibleContent', 'This page has no accessible content.');
				changed.fire();
			}, () => {
				if (isCurrent()) { text = localize('canvas.readFailed', 'Could not read this Canvas. Return to its conversation and try again.'); changed.fire(); }
			});
		} else if (type === AccessibleViewType.View) {
			text = localize('canvas.waitingSource', 'This Canvas is reconnecting…');
		}
		return provider;
	}

	protected override disposeCore(): void {
		this.clearInput();
		this.releaseFrame();
		super.disposeCore();
	}
}

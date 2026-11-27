import { ContentWidgetPositionPreference, type ICodeEditor, type IContentWidget, type IContentWidgetPosition, type IEditorMouseEvent } from '../../../browser/editorBrowser.js';
import './hover.css';
import { addDisposableListener, h, ModifierKeyEmitter } from '../../../../base/browser/dom.js';
import { disposableWindowTimeout } from '../../../../base/browser/scheduler.js';
import { Disposable, MutableDisposable, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { type Position } from '../../../common/core/position.js';
import { type View } from '../../../browser/view.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { HoverParticipantRegistry, type HoverAnchor, type IEditorHoverParticipant, type IEditorHoverRenderContext, type IHoverPart, type IRenderedHoverParts } from './hoverTypes.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';

/** Projects provider-backed hover content into an editor-local, non-modal widget. */
export class ContentHoverController extends Disposable implements IContentWidget {
	public readonly allowEditorOverflow = true;
	public readonly suppressMouseDown = true;
	private readonly element: HTMLDivElement;
	private request: AbortController | undefined;
	private readonly timer = this._register(new MutableDisposable<IDisposable>());
	private readonly modifierKeys: ModifierKeyEmitter;
	private hoverPosition: Position | undefined;
	private anchor: HoverAnchor | undefined;
	private focusPending = false;
	private readonly participants: readonly IEditorHoverParticipant[];
	private readonly renderedParts = this._register(new MutableDisposable<IRenderedHoverParts>());
	private readonly renderedAsyncParts = this._register(new MutableDisposable<IRenderedHoverParts>());
	private readonly hideTimer = this._register(new MutableDisposable<IDisposable>());

	constructor(
		private readonly viewport: View,
		private readonly editor: ICodeEditor,
		private readonly onError: (error: unknown) => void,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.element = h(viewport.domNode.domNode.ownerDocument, 'div');
		this.element.className = 'stanza-editor-hover';
		this.element.hidden = true;
		this.element.setAttribute('role', 'tooltip');
		this.element.setAttribute('aria-label', localize('hover.title', 'Editor hover'));
		this.element.tabIndex = -1;
		this.participants = HoverParticipantRegistry.getAll().map(Participant => instantiationService.createInstance(Participant, editor));
		editor.addContentWidget(this);
		this._register(observeResize(this.element, () => { if (!this.element.hidden) { editor.layoutContentWidget(this); } }));
		this.modifierKeys = ModifierKeyEmitter.getInstance(this.element.ownerDocument.defaultView!);
		this._register(this.modifierKeys.event(() => {
			if (this.anchor && editor.getOption(EditorOption.hover).enabled === 'onKeyboardModifier') {
				this.scheduleAt(this.anchor);
			}
		}));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.hover) || event.hasChanged(EditorOption.multiCursorModifier)) {
				this.scheduleAt(this.anchor);
			}
		}));
		this._register(toDisposable(() => { this.hide(); editor.removeContentWidget(this); this.element.remove(); }));
		this._register(editor.onMouseMove(event => this.schedule(event)));
		this._register(addDisposableListener<PointerEvent>(viewport.domNode.domNode, 'pointerleave', event => {
			if (event.relatedTarget instanceof this.element.ownerDocument.defaultView!.Node && this.element.contains(event.relatedTarget as Node)) { return; }
			this.scheduleHide();
		}));
		this._register(addDisposableListener(this.element, 'pointerenter', () => this.hideTimer.clear()));
		this._register(addDisposableListener<PointerEvent>(this.element, 'pointerleave', event => {
			// Layout can move the hover away from a stationary pointer onto its source.
			if (event.relatedTarget instanceof this.element.ownerDocument.defaultView!.Node && this.anchor?.target?.contains(event.relatedTarget as Node)) {
				this.hideTimer.clear();
				return;
			}
			this.scheduleHide();
		}));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.hide(); editor.focus(); }
		}));
		this._register(addDisposableListener(viewport.domNode.domNode, 'scroll', () => this.hide()));
		this._register(viewport.textModel.onDidChangeContent(() => { if (!this.renderedParts.value?.isUpdatingEditor()) { this.hide(); } }));
		this._register(viewport.textModel.onDidChangeLanguage(() => this.hide()));
		this._register(viewport.textModel.onWillDispose(() => this.hide()));
		for (const participant of this.participants) {
			if (participant.onDidChange) this._register(participant.onDidChange(() => this.hide()));
		}
		this._register(editor.onDidBlurEditorWidget(() => {
			if (!this.element.contains(this.element.ownerDocument.activeElement)) { this.hide(); }
		}));
		this._register(editor.onDidChangeCursorSelection(() => { if (!this.renderedParts.value?.isUpdatingEditor()) { this.hide(); } }));
		this._register(editor.onDidScrollChange(() => this.hide()));
		this._register(addDisposableListener(this.element.ownerDocument, 'pointerdown', event => {
			const target = event.target as Node;
			if (!this.element.contains(target) && !this.anchor?.target?.contains(target)) { this.hide(); }
		}, true));
	}

	public getId(): string { return 'editor.contrib.contentHoverWidget'; }
	public getDomNode(): HTMLElement { return this.element; }
	public getPosition(): IContentWidgetPosition | null {
		if (this.element.hidden || !this.hoverPosition) { return null; }
		const above = this.editor.getOption(EditorOption.hover).above;
		return {
			position: this.hoverPosition, preference: above
				? [ContentWidgetPositionPreference.ABOVE, ContentWidgetPositionPreference.BELOW]
				: [ContentWidgetPositionPreference.BELOW, ContentWidgetPositionPreference.ABOVE]
		};
	}

	public showContentHover(position: Position, target?: HTMLElement): void {
		if (!target && !this.element.hidden) { this.focus(); return; }
		this.hide();
		const anchor: HoverAnchor = { position, target, source: target ? 'click' : 'keyboard' };
		this.anchor = anchor;
		this.focusPending = !target;
		void this.show(anchor);
	}

	public afterRender(position: ContentWidgetPositionPreference | null): void {
		if (position !== null && this.focusPending) { this.focusPending = false; this.focus(); }
	}

	private focus(): void {
		if (this.renderedParts.value) { this.renderedParts.value.focus(); }
		else { this.element.focus({ preventScroll: true }); }
	}

	private schedule(event: IEditorMouseEvent): void {
		if (this.element.contains(event.event.target as Node)) { return; }
		if (!this.element.hidden && this.element.contains(this.element.ownerDocument.activeElement)) { return; }
		for (const participant of this.participants) {
			const anchor = participant.suggestHoverAnchor?.(event);
			if (anchor) {
				if (this.anchor?.position.equals(anchor.position) && this.anchor.target === anchor.target) { this.hideTimer.clear(); return; }
				this.scheduleAt(anchor);
				return;
			}
		}
		const target = this.viewport.getNearestTargetAtClientPoint(event.event);
		if (!target || target.kind !== 'text') {
			this.hide();
			return;
		}
		const element = event.event.target instanceof this.element.ownerDocument.defaultView!.HTMLElement ? event.event.target as HTMLElement : undefined;
		if (this.anchor?.position.equals(target.position) && this.anchor.target === element) { this.hideTimer.clear(); return; }
		this.scheduleAt({ position: target.position, target: element, source: 'mouse' });
	}

	private scheduleAt(anchor: HoverAnchor | undefined): void {
		this.hide();
		this.anchor = anchor;
		if (!anchor) return;
		const options = this.editor.getOption(EditorOption.hover);
		const modifiers = this.modifierKeys.keyStatus;
		const modifierPressed = this.editor.getOption(EditorOption.multiCursorModifier) === 'altKey'
			? (isMacintosh ? modifiers.metaKey : modifiers.ctrlKey)
			: modifiers.altKey;
		if (options.enabled === 'off' || (options.enabled === 'onKeyboardModifier' && !modifierPressed)) return;
		const targetWindow = this.element.ownerDocument.defaultView;
		if (!targetWindow) return;
		this.timer.value = disposableWindowTimeout(targetWindow, () => {
			this.timer.clear();
			void this.show(anchor);
		}, options.delay);
	}

	private async show(anchor: HoverAnchor): Promise<void> {
		const request = this.request = new AbortController();
		const context: IEditorHoverRenderContext = {
			container: this.element,
			hide: () => this.hide(),
			onContentsChanged: () => this.editor.layoutContentWidget(this),
		};
		for (const participant of this.participants) {
			const parts = participant.computeSync(anchor);
			if (parts.length === 0) { continue; }
			this.element.classList.add('interactive');
			this.element.setAttribute('role', 'region');
			this.renderedParts.value = participant.renderHoverParts(context, parts);
			this.showParts(parts[0]!);
			break;
		}
		for (const participant of this.participants) {
			if (request.signal.aborted) return;
			if (!participant.computeAsync) continue;
			try {
				const parts: IHoverPart[] = [];
				for await (const part of participant.computeAsync(anchor, request.signal, this.onError)) {
					if (request.signal.aborted) return;
					parts.push(part);
				}
				if (request.signal.aborted) return;
				if (!parts.length) continue;
				this.renderedAsyncParts.value = participant.renderHoverParts(context, parts);
				this.showParts(parts[0]!);
				return;
			} catch (error) {
				if (!request.signal.aborted) {
					this.onError(error);
				}
			}
		}
	}

	private showParts(firstPart: IHoverPart): void {
		this.hoverPosition ??= firstPart.range.getStartPosition();
		this.element.hidden = false;
		this.editor.layoutContentWidget(this);
	}

	public hide(): void {
		this.hoverPosition = undefined;
		this.focusPending = false;
		this.anchor = undefined;
		this.cancelRequest();
		this.timer.clear();
		this.hideTimer.clear();
		this.element.hidden = true;
		this.renderedParts.clear();
		this.renderedAsyncParts.clear();
		this.element.replaceChildren();
		this.element.classList.remove('interactive');
		this.element.setAttribute('role', 'tooltip');
		this.editor.layoutContentWidget(this);
	}

	private scheduleHide(): void {
		this.hideTimer.value = disposableWindowTimeout(this.element.ownerDocument.defaultView!, () => {
			this.hideTimer.clear();
			if (!this.element.contains(this.element.ownerDocument.activeElement)) { this.hide(); }
		}, this.editor.getOption(EditorOption.hover).hidingDelay);
	}

	private cancelRequest(): void {
		this.request?.abort();
		this.request = undefined;
	}
}

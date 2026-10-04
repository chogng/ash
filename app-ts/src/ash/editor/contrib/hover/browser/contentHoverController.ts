import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type LanguageHover } from '../../../common/languages.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { ContentWidgetPositionPreference, type ICodeEditor, type IContentWidget, type IContentWidgetPosition } from '../../../browser/editorBrowser.js';
import { isNonEmptyArray } from '../../../../base/common/arrays.js';
import "./hover.css";
import { addDisposableListener, h, ModifierKeyEmitter } from "../../../../base/browser/dom.js";
import { disposableWindowTimeout } from "../../../../base/browser/scheduler.js";
import { Disposable, MutableDisposable, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type Position } from "../../../common/core/position.js";
import { type View } from "../../../browser/view.js";
import { EditorOption } from '../../../common/config/editorOptions.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { HoverParticipantRegistry, type HoverAnchor, type IEditorHoverParticipant, type IRenderedHoverParts } from './hoverTypes.js';
import { bindColorTheme } from '../../../../platform/theme/browser/themeStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { localize } from '../../../../nls.js';

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
	private readonly hideTimer = this._register(new MutableDisposable<IDisposable>());

	constructor(
		private readonly viewport: View,
		private readonly editor: ICodeEditor,
		private readonly onError: (error: unknown) => void,
		@ILanguageFeaturesService private readonly languageFeatures: ILanguageFeaturesService,
		@IThemeService themeService: IThemeService,
	) {
		super();
		this.element = h(viewport.domNode.domNode.ownerDocument, "div");
		this.element.className = "stanza-editor-hover";
		this.element.hidden = true;
		this.element.setAttribute("role", "tooltip");
		this.element.setAttribute('aria-label', localize('hover.title', 'Editor hover'));
		this.element.tabIndex = -1;
		this.participants = HoverParticipantRegistry.getAll().map(Participant => new Participant(editor));
		editor.addContentWidget(this);
		this._register(bindColorTheme(themeService, this.element));
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
		this._register(addDisposableListener<PointerEvent>(viewport.domNode.domNode, "pointermove", event => this.schedule(event)));
		this._register(addDisposableListener<PointerEvent>(viewport.domNode.domNode, "pointerleave", event => {
			if (event.relatedTarget instanceof this.element.ownerDocument.defaultView!.Node && this.element.contains(event.relatedTarget as Node)) { return; }
			this.scheduleHide();
		}));
		this._register(addDisposableListener(this.element, 'pointerenter', () => this.hideTimer.clear()));
		this._register(addDisposableListener(this.element, 'pointerleave', () => this.scheduleHide()));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.hide(); editor.focus(); }
		}));
		this._register(addDisposableListener(viewport.domNode.domNode, "scroll", () => this.hide()));
		this._register(viewport.textModel.onDidChangeContent(() => { if (!this.renderedParts.value?.isUpdatingEditor()) { this.hide(); } }));
		this._register(viewport.textModel.onDidChangeLanguage(() => this.hide()));
		this._register(viewport.textModel.onWillDispose(() => this.hide()));
		this._register(languageFeatures.hoverProvider.onDidChange(() => this.hide()));
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
		return { position: this.hoverPosition, preference: above
			? [ContentWidgetPositionPreference.ABOVE, ContentWidgetPositionPreference.BELOW]
			: [ContentWidgetPositionPreference.BELOW, ContentWidgetPositionPreference.ABOVE] };
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

	private schedule(event: PointerEvent): void {
		if (this.element.contains(event.target as Node)) { return; }
		if (!this.element.hidden && this.element.contains(this.element.ownerDocument.activeElement)) { return; }
		const target = this.viewport.getNearestTargetAtClientPoint({ clientX: event.clientX, clientY: event.clientY });
		if (!target || target.kind !== "text") {
			this.hide();
			return;
		}
		const element = event.target instanceof this.element.ownerDocument.defaultView!.HTMLElement ? event.target as HTMLElement : undefined;
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
		const position = anchor.position;
		for (const participant of this.participants) {
			const parts = participant.computeSync(anchor);
			if (parts.length === 0) { continue; }
			this.element.classList.add('interactive');
			this.element.setAttribute('role', 'region');
			this.hoverPosition = parts[0]!.range.getStartPosition();
			this.renderedParts.value = participant.renderHoverParts({
				container: this.element,
				hide: () => this.hide(),
				onContentsChanged: () => this.editor.layoutContentWidget(this),
			}, parts);
			this.element.hidden = false;
			this.editor.layoutContentWidget(this);
			break;
		}
		const model = this.viewport.textModel;
		const context = {
			...createLanguageFeatureRequest(model, model.getLanguageId(), request.signal),
			resource: model.uri,
			position,
		};
		for (const provider of this.languageFeatures.hoverProvider.ordered(model)) {
			if (!isLanguageFeatureRequestCurrent(context)) {
				return;
			}
			try {
				const result = await provider.provideHover(context, request.signal);
				if (!isLanguageFeatureRequestCurrent(context)) {
					return;
				}
				if (result) {
					this.render(normalizeLanguageHover(result), position);
					return;
				}
			} catch (error) {
				if (!request.signal.aborted) {
					this.onError(error);
				}
			}
		}
	}

	private render(hover: LanguageHover, position: Position): void {
		this.element.append(...hover.contents.map(content => {
			const node = h(this.element.ownerDocument, "div");
			node.className = "stanza-editor-hover-content";
			node.textContent = typeof content === "string" ? content : content.value;
			return node;
		}));
		this.hoverPosition ??= hover.range?.getStartPosition() ?? position;
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

function normalizeLanguageHover(value: LanguageHover): LanguageHover {
	if (!value || typeof value !== "object" || !isNonEmptyArray(value.contents)) throw new TypeError("Language hover must contain content");
	const contents = value.contents.map(content => {
		if (typeof content === "string") return content;
		if (!content || typeof content !== "object" || typeof content.value !== "string") throw new TypeError("Language hover content must contain a string value");
		return Object.freeze({ value: content.value, ...(content.language !== undefined ? { language: content.language } : {}) });
	});
	return Object.freeze({ ...(value.range ? { range: value.range } : {}), contents: Object.freeze(contents) });
}

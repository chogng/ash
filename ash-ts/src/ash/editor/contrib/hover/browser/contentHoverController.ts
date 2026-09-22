import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type LanguageHover } from '../../../common/languages.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { isNonEmptyArray } from '../../../../base/common/arrays.js';
import "./hover.css";
import { addDisposableListener, h, ModifierKeyEmitter } from "../../../../base/browser/dom.js";
import { disposableWindowTimeout } from "../../../../base/browser/scheduler.js";
import { Disposable, MutableDisposable, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type Position } from "../../../common/core/position.js";
import { type View } from "../../../browser/view.js";
import { EditorOption } from '../../../common/config/editorOptions.js';
import { isMacintosh } from '../../../../base/common/platform.js';

/** Projects provider-backed hover content into an editor-local, non-modal widget. */
export class ContentHoverController extends Disposable {
	private readonly element: HTMLDivElement;
	private request: AbortController | undefined;
	private readonly timer = this._register(new MutableDisposable<IDisposable>());
	private readonly modifierKeys: ModifierKeyEmitter;
	private hoverPosition: Position | undefined;

	constructor(
		private readonly viewport: View,
		private readonly editor: ICodeEditor,
		private readonly onError: (error: unknown) => void,
		@ILanguageFeaturesService private readonly languageFeatures: ILanguageFeaturesService,
	) {
		super();
		this.element = h(viewport.domNode.domNode.ownerDocument, "div");
		this.element.className = "stanza-editor-hover";
		this.element.hidden = true;
		this.element.setAttribute("role", "tooltip");
		viewport.domNode.domNode.append(this.element);
		this.modifierKeys = ModifierKeyEmitter.getInstance(this.element.ownerDocument.defaultView!);
		this._register(this.modifierKeys.event(() => {
			if (this.hoverPosition && editor.getOption(EditorOption.hover).enabled === 'onKeyboardModifier') {
				this.scheduleAt(this.hoverPosition);
			}
		}));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.hover) || event.hasChanged(EditorOption.multiCursorModifier)) {
				this.scheduleAt(this.hoverPosition);
			}
		}));
		this._register(toDisposable(() => { this.cancelRequest(); this.element.remove(); }));
		this._register(addDisposableListener<PointerEvent>(viewport.domNode.domNode, "pointermove", event => this.schedule(event)));
		this._register(addDisposableListener(viewport.domNode.domNode, "pointerleave", () => this.hide()));
		this._register(addDisposableListener(viewport.domNode.domNode, "scroll", () => this.hide()));
		this._register(viewport.textModel.onDidChangeContent(() => this.hide()));
		this._register(viewport.textModel.onDidChangeLanguage(() => this.hide()));
		this._register(viewport.textModel.onWillDispose(() => this.hide()));
		this._register(languageFeatures.hoverProvider.onDidChange(() => this.hide()));
		this._register(editor.onDidBlurEditorWidget(() => this.hide()));
		this._register(editor.onDidChangeCursorSelection(() => this.hide()));
	}

	private schedule(event: PointerEvent): void {
		const target = this.viewport.getNearestTargetAtClientPoint({ clientX: event.clientX, clientY: event.clientY });
		if (!target || target.kind !== "text") {
			this.hide();
			return;
		}
		this.scheduleAt(target.position);
	}

	private scheduleAt(position: Position | undefined): void {
		this.hide();
		this.hoverPosition = position;
		if (!position) return;
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
			void this.show(position);
		}, options.delay);
	}

	private async show(position: Position): Promise<void> {
		const request = this.request = new AbortController();
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
		this.element.replaceChildren(...hover.contents.map(content => {
			const node = h(this.element.ownerDocument, "div");
			node.className = "stanza-editor-hover-content";
			node.textContent = typeof content === "string" ? content : content.value;
			return node;
		}));
		const coordinates = this.viewport.getPositionContentCoordinates(hover.range?.getStartPosition() ?? position);
		const bounds = this.viewport.domNode.domNode.getBoundingClientRect();
		const width = Math.min(480, Math.max(160, bounds.width - 16));
		this.element.style.maxWidth = `${width}px`;
		this.element.style.left = `${Math.max(8, coordinates.left - this.viewport.viewportLayout.scrollPosition.left)}px`;
		this.element.style.top = `${Math.max(8, coordinates.top - this.viewport.viewportLayout.scrollPosition.top + coordinates.height + 4)}px`;
		this.element.hidden = false;
	}

	private hide(): void {
		this.hoverPosition = undefined;
		this.cancelRequest();
		this.timer.clear();
		this.element.hidden = true;
		this.element.replaceChildren();
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

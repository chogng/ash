import { addDisposableListener, getActiveElement, getWindow, h, isHTMLElement, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { MouseTargetType, type ICodeEditor, type IGlyphMarginWidget } from '../../../../editor/browser/editorBrowser.js';
import { Range } from '../../../../editor/common/core/range.js';
import { GlyphMarginLane } from '../../../../editor/common/model.js';
import { localize } from '../../../../nls.js';
import './media/review.css';

export interface ICommentThreadEditorWidgetOptions {
	readonly canAdd: (line: number) => boolean;
	readonly getTitle?: (line: number) => string | undefined;
	readonly render: (line: number, body: HTMLElement, resources: DisposableStore) => HTMLElement | undefined;
	readonly onOpen: (line: number) => void;
}

interface ReviewGlyph extends IDisposable {
	readonly button: HTMLButtonElement;
}

export interface ICommentThreadPresentation {
	readonly closeLabel: string;
	revealLine(line: number): void;
	mount(line: number, panel: HTMLElement, resources: DisposableStore, host: ICommentThreadPresentationHost): boolean;
}

export interface ICommentThreadPresentationHost {
	dismiss(restoreFocus: boolean): void;
	isThreadMarker(target: Node): boolean;
}

interface ActiveCommentThread {
	readonly line: number;
	readonly panel: HTMLElement;
	readonly body: HTMLElement;
	readonly closeButton: HTMLButtonElement;
	readonly content: DisposableStore;
	composer?: HTMLElement;
}

/** Owns editor gutter controls and the active thread. Each presentation owns its placement. */
export class CommentThreadEditorWidget extends Disposable {
	private readonly markers = this._register(new DisposableMap<number, ReviewGlyph>());
	private readonly addMarker = this._register(new MutableDisposable<ReviewGlyph>());
	private readonly threadResources = this._register(new MutableDisposable<DisposableStore>());
	private readonly placement = this._register(new MutableDisposable<DisposableStore>());
	private hoverLine: number | undefined;
	private active: ActiveCommentThread | undefined;

	constructor(private readonly editor: ICodeEditor, private readonly options: ICommentThreadEditorWidgetOptions, private presentation: ICommentThreadPresentation) {
		super();
		this._register(editor.onMouseMove(({ target }) => {
			if (target.element?.closest('.ash-review-glyph')) return;
			const margin = target.type === MouseTargetType.GUTTER_GLYPH_MARGIN || target.type === MouseTargetType.GUTTER_LINE_NUMBERS;
			this.setHoverLine(margin && !target.detail.isAfterLines ? target.position.lineNumber : undefined);
		}));
		this._register(editor.onMouseLeave(() => this.setHoverLine(undefined)));
	}

	public update(lines: ReadonlySet<number>): void {
		for (const line of this.markers.keys()) {
			if (!lines.has(line)) this.markers.deleteAndDispose(line);
		}
		for (const line of lines) {
			if (!this.markers.has(line) && this.hasLine(line)) this.markers.set(line, this.createGlyph(line, true));
		}
		this.updateAddMarker();
		this.renderBody();
	}

	public show(line: number, focusComposer = false): boolean {
		if (!this.hasLine(line) || (!this.markers.has(line) && !this.options.canAdd(line))) return false;
		if (this.active?.line !== line) {
			this.options.onOpen(line);
			this.close();
			if (!this.createThread(line)) {
				this.close();
				return false;
			}
			this.markers.get(line)?.button.setAttribute('aria-expanded', 'true');
		} else {
			this.presentation.revealLine(line);
		}
		const active = this.active;
		if (!active) return false;
		this.focus(active, focusComposer ? active.composer ?? active.panel : active.panel);
		return true;
	}

	private focus(active: ActiveCommentThread, target: HTMLElement): void {
		target.focus({ preventScroll: true });
		if (target.ownerDocument.activeElement !== target) {
			this.placement.value?.add(scheduleAtNextAnimationFrame(getWindow(target), () => {
				if (this.active === active && active.panel.contains(target)) target.focus({ preventScroll: true });
			}));
		}
	}

	public close(): void {
		if (this.active) this.markers.get(this.active.line)?.button.setAttribute('aria-expanded', 'false');
		this.active = undefined;
		this.placement.clear();
		this.threadResources.clear();
	}

	protected setPresentation(presentation: ICommentThreadPresentation): void {
		if (this.presentation === presentation) return;
		this.presentation = presentation;
		const active = this.active;
		if (!active) return;
		const focused = getActiveElement(active.panel.ownerDocument);
		const restoreFocus = isHTMLElement(focused) && active.panel.contains(focused);
		// Move the existing panel so native input state and the callers' drafts survive the setting change.
		this.placement.clear();
		if (!this.mount(active)) {
			this.close();
			if (restoreFocus) this.editor.focus();
		} else if (restoreFocus) {
			this.focus(active, focused);
		}
	}

	private hasLine(line: number): boolean {
		return line >= 1 && line <= (this.editor.getModel()?.getLineCount() ?? 0);
	}

	private setHoverLine(line: number | undefined): void {
		if (this.hoverLine === line) return;
		this.hoverLine = line;
		this.updateAddMarker();
	}

	private updateAddMarker(): void {
		this.addMarker.clear();
		const line = this.hoverLine;
		if (line !== undefined && this.hasLine(line) && !this.markers.has(line) && this.options.canAdd(line)) {
			this.addMarker.value = this.createGlyph(line, false);
		}
	}

	private createGlyph(line: number, discussion: boolean): ReviewGlyph {
		const resources = new DisposableStore();
		const button = h(this.editor.getContainerDomNode().ownerDocument, 'button', {
			className: 'ash-review-glyph',
			properties: { type: 'button', tabIndex: discussion ? 0 : -1 },
		});
		const label = discussion
			? localize('comments.review.openLine', 'Open comments on line {0}', line)
			: localize('comments.review.addLine', 'Add comment on line {0}', line);
		button.setAttribute('aria-label', label);
		if (discussion) button.setAttribute('aria-expanded', String(this.active?.line === line));
		button.title = label;
		const icon = h(button.ownerDocument, 'span', { attributes: { 'aria-hidden': 'true' } });
		appendIcon(discussion ? Lxicon.comment : Lxicon.add, icon);
		button.append(icon);
		resources.add(addDisposableListener(button, 'mousedown', event => event.stopPropagation()));
		resources.add(addDisposableListener(button, 'click', () => {
			if (discussion && this.active?.line === line) this.close();
			else this.show(line, !discussion);
		}));
		const glyph: IGlyphMarginWidget = {
			getId: () => discussion ? `review-thread-${line}` : 'review-add-comment',
			getDomNode: () => button,
			getPosition: () => ({ lane: GlyphMarginLane.Center, range: new Range(line, 1, line, 1), zIndex: 1 }),
		};
		this.editor.addGlyphMarginWidget(glyph);
		resources.add(toDisposable(() => this.editor.removeGlyphMarginWidget(glyph)));
		return Object.assign(toDisposable(() => resources.dispose()), { button });
	}

	private createThread(line: number): boolean {
		const resources = this.threadResources.value = new DisposableStore();
		const document = this.editor.getContainerDomNode().ownerDocument;
		const title = this.options.getTitle?.(line) ?? localize('comments.review.lineComments', 'Comments on line {0}', line);
		const panel = h(document, 'section', {
			className: 'ash-review-zone-panel',
			properties: { tabIndex: -1 },
			attributes: { 'aria-label': title },
		});
		const dismiss = () => {
			this.close();
			this.editor.focus();
		};
		const close = h(document, 'button', { className: 'ash-button ash-button-quiet', properties: { type: 'button' } });
		resources.add(addDisposableListener(close, 'click', dismiss));
		resources.add(addDisposableListener(panel, 'keydown', event => {
			if (!event.isComposing && event.key === 'Escape' && !event.defaultPrevented) {
				event.stopPropagation();
				dismiss();
			}
		}));
		const body = h(document, 'div', { className: 'ash-review-zone-body' });
		panel.append(h(document, 'header', { className: 'ash-review-zone-header' }, h(document, 'strong', title), close), body);
		this.active = { line, panel, body, closeButton: close, content: resources.add(new DisposableStore()) };
		this.renderBody();
		return this.mount(this.active);
	}

	private mount(active: ActiveCommentThread): boolean {
		const resources = this.placement.value = new DisposableStore();
		active.closeButton.textContent = this.presentation.closeLabel;
		return this.presentation.mount(active.line, active.panel, resources, {
			dismiss: restoreFocus => {
				if (this.placement.value !== resources) return;
				this.close();
				if (restoreFocus) this.editor.focus();
			},
			isThreadMarker: target => this.markers.get(active.line)?.button.contains(target) === true,
		});
	}

	private renderBody(): void {
		const active = this.active;
		if (!active) return;
		active.content.clear();
		active.body.replaceChildren();
		active.composer = this.options.render(active.line, active.body, active.content);
	}
}

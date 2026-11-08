import { addDisposableListener, getWindow, h, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { observeElementSize } from '../../../../base/browser/observer.js';
import { AnimationFrameScheduler } from '../../../../base/browser/scheduler.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { MouseTargetType, type ICodeEditor, type IGlyphMarginWidget, type IViewZone } from '../../../../editor/browser/editorBrowser.js';
import { Range } from '../../../../editor/common/core/range.js';
import type { LineDiffRows } from '../../../../editor/common/diff/lineDiff.js';
import { GlyphMarginLane } from '../../../../editor/common/model.js';
import { localize } from '../../../../nls.js';
import './media/review.css';

interface ReviewZoneOptions {
	readonly canAdd: (line: number) => boolean;
	readonly getTitle?: (line: number) => string | undefined;
	readonly render: (line: number, body: HTMLElement, resources: DisposableStore) => HTMLElement | undefined;
	readonly onOpen: () => void;
	readonly comparison?: {
		readonly editor: ICodeEditor;
		readonly original: boolean;
		readonly rows: () => LineDiffRows | undefined;
	};
}

interface ReviewGlyph extends IDisposable {
	readonly button: HTMLButtonElement;
}

/** Owns gutter controls and an inline editor zone. The caller supplies comment content and actions. */
export class ReviewZoneWidget extends Disposable {
	private readonly markers = this._register(new DisposableMap<number, ReviewGlyph>());
	private readonly addMarker = this._register(new MutableDisposable<ReviewGlyph>());
	private readonly zoneResources = this._register(new MutableDisposable<DisposableStore>());
	private hoverLine: number | undefined;
	private active: { readonly line: number; readonly panel: HTMLElement; readonly body: HTMLElement; readonly content: DisposableStore; composer?: HTMLElement; } | undefined;

	constructor(private readonly editor: ICodeEditor, private readonly options: ReviewZoneOptions) {
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
			this.options.onOpen();
			this.close();
			this.createZone(line);
			this.markers.get(line)?.button.setAttribute('aria-expanded', 'true');
		}
		const active = this.active!;
		this.editor.setPosition({ lineNumber: line, column: 1 });
		this.editor.revealRange(new Range(line, 1, line, 1));
		const target = focusComposer ? active.composer ?? active.panel : active.panel;
		target.focus();
		if (target.ownerDocument.activeElement !== target) {
			this.zoneResources.value?.add(scheduleAtNextAnimationFrame(getWindow(target), () => {
				if (this.active === active) (focusComposer ? active.composer ?? active.panel : active.panel).focus();
			}));
		}
		return true;
	}

	public close(): void {
		if (this.active) this.markers.get(this.active.line)?.button.setAttribute('aria-expanded', 'false');
		this.active = undefined;
		this.zoneResources.clear();
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

	private createZone(line: number): void {
		const resources = this.zoneResources.value = new DisposableStore();
		const document = this.editor.getContainerDomNode().ownerDocument;
		const root = h(document, 'div', { className: 'ash-review-zone' });
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
		const close = h(document, 'button', { className: 'ash-button ash-button-quiet', properties: { type: 'button' } }, localize('comments.review.close', 'Close inline comments'));
		resources.add(addDisposableListener(close, 'click', dismiss));
		resources.add(addDisposableListener(panel, 'keydown', event => {
			if (event.key === 'Escape' && !event.defaultPrevented) {
				event.stopPropagation();
				dismiss();
			}
		}));
		const body = h(document, 'div', { className: 'ash-review-zone-body' });
		panel.append(h(document, 'header', { className: 'ash-review-zone-header' }, h(document, 'strong', title), close), body);
		root.append(panel);
		const updateWidth = () => { panel.style.width = `${this.editor.getLayoutInfo().contentWidth}px`; };
		const updateOffset = () => { panel.style.marginLeft = `${this.editor.getScrollLeft()}px`; };
		updateWidth();
		updateOffset();
		resources.add(this.editor.onDidLayoutChange(updateWidth));
		resources.add(this.editor.onDidScrollChange(event => { if (event.scrollLeftChanged) updateOffset(); }));
		this.active = { line, panel, body, content: resources.add(new DisposableStore()) };
		this.renderBody();

		const alignment = this.getAlignment(line);
		const zone: IViewZone = { afterLineNumber: line, ordinal: alignment?.ordinal, heightInPx: 1, domNode: root, isAccessible: true };
		let zoneId: string;
		this.editor.changeViewZones(accessor => { zoneId = accessor.addZone(zone); });
		resources.add(toDisposable(() => this.editor.changeViewZones(accessor => accessor.removeZone(zoneId))));

		const peer = this.options.comparison?.editor;
		let spacer: IViewZone | undefined;
		let spacerId: string;
		if (peer && alignment) {
			// Reserve the same height on the other side so subsequent diff rows stay aligned.
			const peerZone: IViewZone = { afterLineNumber: alignment.line, ordinal: alignment.ordinal, heightInPx: 1, domNode: h(document, 'div') };
			spacer = peerZone;
			peer.changeViewZones(accessor => { spacerId = accessor.addZone(peerZone); });
			resources.add(toDisposable(() => peer.changeViewZones(accessor => accessor.removeZone(spacerId))));
		}
		let pixels = 0;
		// Laying out the zone can resize both diff editors. Do it outside observer delivery.
		const layout = resources.add(new AnimationFrameScheduler(getWindow(panel), () => {
			if (!pixels || pixels === zone.heightInPx) return;
			zone.heightInPx = pixels;
			this.editor.changeViewZones(accessor => accessor.layoutZone(zoneId));
			if (spacer && peer) {
				spacer.heightInPx = pixels;
				peer.changeViewZones(accessor => accessor.layoutZone(spacerId));
			}
		}));
		resources.add(observeElementSize(panel, ({ height }) => {
			pixels = Math.ceil(height);
			layout.schedule();
		}));
	}

	private renderBody(): void {
		const active = this.active;
		if (!active) return;
		active.content.clear();
		active.body.replaceChildren();
		active.composer = this.options.render(active.line, active.body, active.content);
	}

	private getAlignment(line: number): { line: number; ordinal: number; } | undefined {
		const comparison = this.options.comparison;
		const rows = comparison?.rows();
		if (!rows || !comparison) return undefined;
		let previousPeerLine = 0;
		for (const [index, row] of rows.alignmentEntries()) {
			const source = comparison.original ? row.originalLineIndex : row.modifiedLineIndex;
			const peer = comparison.original ? row.modifiedLineIndex : row.originalLineIndex;
			if (source !== undefined && source + 1 >= line) {
				// Unchanged runs are represented by their last row in alignmentEntries.
				const offset = source + 1 - line;
				return { line: peer === undefined ? previousPeerLine : peer + 1 - offset, ordinal: index - offset + 0.5 };
			}
			if (peer !== undefined) previousPeerLine = peer + 1;
		}
		return undefined;
	}
}

import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import './artifactFrameNavigator.css';
import { addDisposableListener, h, svg } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { renderArtifactCanvasShape } from './rendering/artifactCanvasSvgRenderer.js';
import type { ArtifactCanvasDocumentController } from './artifactCanvasDocumentController.js';
import type { ArtifactCanvasShape } from '../common/model/artifactCanvasDocument.js';

/** Slides and website pages share frame selection and read-only scene playback. */
export class ArtifactFrameNavigator extends Disposable {
	public readonly domNode: HTMLElement;
	public readonly previewDomNode: HTMLElement;
	private readonly selectDomNode: HTMLSelectElement;
	private readonly sceneDomNode: SVGSVGElement;
	private readonly previous: Button;
	private readonly next: Button;
	private readonly counterDomNode: HTMLElement;
	private readonly editorDomNode: HTMLElement;
	private readonly selectionChange = this._register(new Emitter<void>());
	public readonly onDidChangeSelection = this.selectionChange.event;
	private frameId: string | undefined;
	private presenting = false;
	private renderedFrames: readonly ArtifactCanvasShape[] = [];

	constructor(container: HTMLElement, content: HTMLElement, private readonly document: ArtifactCanvasDocumentController, private readonly reveal: (id: string) => void) {
		super();
		const ownerDocument = container.ownerDocument;
		this.editorDomNode = content.firstElementChild as HTMLElement;
		this.domNode = h(ownerDocument, 'label', { className: 'ash-artifacts-frame-selector' }, localize('sessions.artifacts.page', 'Page'));
		this.selectDomNode = h(ownerDocument, 'select', { attributes: { 'aria-label': localize('sessions.artifacts.pages', 'Pages') } });
		this.domNode.append(this.selectDomNode);
		container.append(this.domNode);
		this.previewDomNode = h(ownerDocument, 'section', { className: 'ash-artifacts-frame-preview', attributes: { role: 'region', 'aria-label': localize('sessions.artifacts.preview', 'Presentation preview'), tabindex: '0' } });
		this.previewDomNode.hidden = true;
		const controls = h(ownerDocument, 'div', { className: 'ash-artifacts-preview-controls' });
		this.previous = this._register(new Button(controls, {
			...defaultButtonStyles,
			label: localize('sessions.artifacts.previousPage', 'Previous page'),
			onClick: () => this.move(-1),
		}));
		this.counterDomNode = h(ownerDocument, 'span', { attributes: { role: 'status', 'aria-live': 'polite' } });
		controls.append(this.counterDomNode);
		this.next = this._register(new Button(controls, {
			...defaultButtonStyles,
			label: localize('sessions.artifacts.nextPage', 'Next page'),
			onClick: () => this.move(1),
		}));
		this._register(new Button(controls, {
			...defaultButtonStyles,
			label: localize('sessions.artifacts.closePreview', 'Close preview'),
			onClick: () => this.showPreview(false),
		}));
		this.sceneDomNode = svg(ownerDocument, 'svg', { className: 'ash-artifacts-preview-scene' });
		this.previewDomNode.append(controls, this.sceneDomNode);
		content.append(this.previewDomNode);
		this._register(addDisposableListener(this.selectDomNode, 'change', () => this.select(this.selectDomNode.value)));
		this._register(addDisposableListener(this.previewDomNode, 'keydown', event => {
			if (event.key === 'Escape') { event.preventDefault(); this.showPreview(false); }
			else if (event.target === this.previewDomNode && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); this.move(event.key === 'ArrowLeft' ? -1 : 1); }
		}));
		this._register(document.model.onDidChange(() => this.update()));
		this.update();
	}
	public get frames(): readonly ArtifactCanvasShape[] { return this.document.model.value.shapes.filter(shape => shape.kind === 'frame'); }
	public get selectedId(): string | undefined { return this.frameId; }
	public get isPresenting(): boolean { return this.presenting; }
	public focus(): void { this.previewDomNode.focus(); }
	public select(id: string): void { this.setSelectedId(id); this.update(); this.reveal(id); }
	public showPreview(visible: boolean): void {
		this.presenting = visible;
		this.editorDomNode.inert = visible;
		this.previewDomNode.hidden = !visible;
		if (visible) { this.renderPreview(); this.previewDomNode.focus(); }
		else { this.selectDomNode.focus(); }
	}
	public setVisible(visible: boolean): void { this.previewDomNode.hidden = !visible || !this.presenting; }
	private setSelectedId(id: string | undefined): void {
		if (this.frameId === id) return;
		this.frameId = id;
		this.selectionChange.fire();
	}
	private move(offset: number): void {
		const frames = this.frames;
		const index = frames.findIndex(frame => frame.id === this.frameId);
		const frame = frames[index + offset];
		if (frame) { this.setSelectedId(frame.id); this.selectDomNode.value = frame.id; this.renderPreview(); }
	}
	private update(): void {
		const frames = this.frames;
		if (!frames.some(frame => frame.id === this.frameId)) { this.setSelectedId(frames[0]?.id); }
		if (frames.length !== this.renderedFrames.length || frames.some((frame, index) => frame !== this.renderedFrames[index])) {
			this.renderedFrames = frames;
			this.selectDomNode.replaceChildren(...frames.map((frame, index) => h(this.domNode.ownerDocument, 'option', { properties: { value: frame.id } }, localize('sessions.artifacts.pageNumber', 'Page {0}', index + 1))));
		}
		this.selectDomNode.disabled = frames.length === 0;
		this.selectDomNode.value = this.frameId ?? '';
		this.renderPreview();
	}
	private renderPreview(): void {
		const frames = this.frames;
		const index = frames.findIndex(frame => frame.id === this.frameId);
		this.previous.enabled = index > 0;
		this.next.enabled = index >= 0 && index < frames.length - 1;
		this.counterDomNode.textContent = localize('sessions.artifacts.pageCount', '{0} of {1}', index + 1, frames.length);
		const frame = frames[index];
		if (!frame) { this.sceneDomNode.replaceChildren(); return; }
		if (!this.presenting) { return; }
		this.sceneDomNode.setAttribute('viewBox', `0 0 ${frame.width} ${frame.height}`);
		this.sceneDomNode.replaceChildren(renderArtifactCanvasShape({ ...frame, x: 0, y: 0, rotation: 0 }, undefined, this.document.getEmbeddedImageSources()));
	}
}

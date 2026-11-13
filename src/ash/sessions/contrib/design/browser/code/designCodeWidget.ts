import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import './designCodeWidget.css';
import { h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { ArtifactCanvasDocumentController } from '../../../artifact/browser/artifactCanvasDocumentController.js';
import type { ArtifactCanvasDocument } from '../../../artifact/common/model/artifactCanvasDocument.js';
import { generateDesignCode } from './designCodeGenerator.js';

/** Shows source from the same document snapshot used by file export. */
export class DesignCodeWidget extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly source: HTMLTextAreaElement;
	private readonly exportButton: Button;
	private document: ArtifactCanvasDocument | undefined;

	constructor(ownerDocument: Document, private readonly documentController: ArtifactCanvasDocumentController, exportCode: () => Promise<void>) {
		super();
		this.domNode = h(ownerDocument, 'section', { className: 'ash-design-code-widget', attributes: { 'aria-label': localize('sessions.design.generatedCode', 'Generated code') } });
		const header = h(ownerDocument, 'div', { className: 'ash-design-code-header' });
		header.append(h(ownerDocument, 'span', {}, localize('sessions.design.codeHint', 'Runnable HTML/CSS/SVG with object IDs, keyframes and editable design JSON for agents.')));
		this.exportButton = this._register(new Button(header, {
			...defaultButtonStyles,
			label: localize('sessions.design.exportCode', 'Export code'),
			onClick: exportCode,
		}));
		this.source = h(ownerDocument, 'textarea', { properties: { readOnly: true, spellcheck: false }, attributes: { 'aria-label': localize('sessions.design.generatedCode', 'Generated code') } });
		this.domNode.append(header, this.source);
	}

	public update(document: ArtifactCanvasDocument, isActive: boolean, isBusy: boolean): void {
		this.domNode.classList.toggle('visible', isActive);
		this.exportButton.enabled = !isBusy && document.shapes.length > 0;
		if (isActive && this.document !== document) { this.source.value = generateDesignCode(document, this.documentController.getEmbeddedImageSources(document)); this.document = document; }
	}

	public getAccessibleContent(): string { return this.source.value; }
	public getSource(): string { return generateDesignCode(this.documentController.model.value, this.documentController.getEmbeddedImageSources()); }
}

import './artifactTableExample.css';
import { h, type IDimension } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { getNLSLanguage } from '../../../../nls.js';
import type { TableArtifactExample } from './artifactExamples.js';
import type { IArtifactWorkspace } from './artifactWorkspaceRegistry.js';

/** The Sheet and Data examples preview the content without requiring a file editor. */
export class ArtifactTableExample extends Disposable implements IArtifactWorkspace {
	public readonly domNode: HTMLElement;
	public readonly usesCanvasPanels = false;

	constructor(ownerDocument: Document, private readonly example: TableArtifactExample) {
		super();
		const sheet = example.kind === 'sheet';
		const numberFormat = new Intl.NumberFormat(getNLSLanguage());
		this.domNode = h(ownerDocument, 'section', {
			className: `ash-artifact-table-example ${example.kind}`,
			attributes: { 'aria-label': example.title, tabindex: '0' },
		});
		if (example.summary) {
			const summary = h(ownerDocument, 'dl', { className: 'ash-artifact-example-summary' });
			for (const { label, value } of example.summary) {
				summary.append(h(ownerDocument, 'div', {}, h(ownerDocument, 'dt', {}, label), h(ownerDocument, 'dd', {}, numberFormat.format(value))));
			}
			this.domNode.append(summary);
		}

		const table = h(ownerDocument, 'table', {}, h(ownerDocument, 'caption', {}, example.detail));
		const head = table.createTHead();
		if (sheet) {
			const coordinates = head.insertRow();
			coordinates.append(h(ownerDocument, 'td'));
			example.columns.forEach((_, index) => coordinates.append(h(ownerDocument, 'td', {}, String.fromCharCode(65 + index))));
			coordinates.setAttribute('aria-hidden', 'true');
		}
		const headers = head.insertRow();
		if (sheet) { headers.append(h(ownerDocument, 'td', { attributes: { 'aria-hidden': 'true' } }, '1')); }
		for (const [index, label] of example.columns.entries()) {
			headers.append(h(ownerDocument, 'th', {
				className: typeof example.rows[0]?.[index] === 'number' ? 'numeric' : '',
				attributes: { scope: 'col' },
			}, label));
		}
		const body = table.createTBody();
		for (const [index, values] of example.rows.entries()) {
			const row = body.insertRow();
			if (sheet) { row.append(h(ownerDocument, 'td', { attributes: { 'aria-hidden': 'true' } }, String(index + 2))); }
			for (const value of values) {
				row.append(h(ownerDocument, 'td', {
					className: typeof value === 'number' ? 'numeric' : '',
				}, typeof value === 'number' ? numberFormat.format(value) : value));
			}
		}
		this.domNode.append(table);
	}

	public create(container: HTMLElement): void { container.append(this.domNode); }
	public setVisible(_visible: boolean): void { }
	public layout(_dimension: IDimension): void { }
	public focus(): void { this.domNode.focus(); }
	public getAccessibleContent(): string {
		return [
			this.example.detail,
			...(this.example.summary?.map(({ label, value }) => `${label}: ${value}`) ?? []),
			this.example.columns.join('\t'),
			...this.example.rows.map(row => row.join('\t')),
		].join('\n');
	}
}

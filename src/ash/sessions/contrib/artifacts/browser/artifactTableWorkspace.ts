import './artifactTableWorkspace.css';
import { h, type IDimension } from '../../../../base/browser/dom.js';
import { Action } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { TableArtifactExample } from './artifactExamples.js';
import type { IArtifactWorkspace } from './artifactWorkspaceRegistry.js';

export type TableArtifactKind = 'sheet' | 'data';

export class ArtifactTableWorkspace extends Disposable implements IArtifactWorkspace {
	public readonly domNode: HTMLElement;
	public readonly usesCanvasPanels = false;
	public readonly toolbarActions: readonly Action[];
	private readonly rows: string[][] = [];
	private columns = 3;

	constructor(
		ownerDocument: Document,
		public readonly kind: TableArtifactKind,
		public readonly title: string,
		private readonly example: TableArtifactExample | undefined,
		@IFileDialogService private readonly dialogs: IFileDialogService,
		@IFileService private readonly files: IFileService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.domNode = h(ownerDocument, 'section', {
			className: `ash-artifact-table-workspace ${kind}`,
			attributes: { 'aria-label': title, 'data-creator-mode': kind, tabindex: '0' },
		});
		if (example) {
			this.toolbarActions = [];
			this.renderExample(example);
		} else {
			this.domNode.classList.add('editable');
			const addRow = this._register(new Action('sessions.artifacts.table.addRow', localize({ bundle: 'ash.artifacts', key: 'addRow' }, 'Add row'), '', true, () => this.addRow()));
			const addColumn = this._register(new Action('sessions.artifacts.table.addColumn', localize({ bundle: 'ash.artifacts', key: 'addColumn' }, 'Add column'), '', true, () => this.addColumn()));
			const save = this._register(new Action('sessions.artifacts.table.save', localize({ bundle: 'ash.artifacts', key: 'saveCsv' }, 'Save as CSV'), '', true, () => this.save()));
			save.icon = Lxicon.save;
			this.toolbarActions = [addRow, addColumn, save];
			this.rows.push(Array<string>(this.columns).fill(''));
			this.renderDraft();
		}
	}

	private renderExample(example: TableArtifactExample): void {
		const ownerDocument = this.domNode.ownerDocument;
		const sheet = this.kind === 'sheet';
		const numberFormat = new Intl.NumberFormat(getNLSLanguage());
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

	private renderDraft(focus?: { row: number; column: number; }): void {
		const document = this.domNode.ownerDocument;
		const table = h(document, 'table', { attributes: { 'aria-label': this.title } });
		const headings = table.createTHead().insertRow();
		headings.append(h(document, 'td'));
		for (let column = 0; column < this.columns; column++) {
			headings.append(h(document, 'th', { attributes: { scope: 'col' } }, getColumnName(column)));
		}
		const body = table.createTBody();
		let active: HTMLInputElement | undefined;
		for (const [row, values] of this.rows.entries()) {
			const line = body.insertRow();
			line.append(h(document, 'th', { attributes: { scope: 'row' } }, String(row + 1)));
			for (const [column, value] of values.entries()) {
				const input = h(document, 'input', {
					properties: { value },
					attributes: { 'aria-label': localize({ bundle: 'ash.artifacts', key: 'cell' }, 'Cell {0}', `${getColumnName(column)}${row + 1}`) },
				});
				input.oninput = () => { values[column] = input.value; };
				line.insertCell().append(input);
				if (focus?.row === row && focus.column === column) active = input;
			}
		}
		this.domNode.replaceChildren(table);
		active?.focus();
	}

	private addRow(): void {
		this.rows.push(Array<string>(this.columns).fill(''));
		this.renderDraft({ row: this.rows.length - 1, column: 0 });
	}

	private addColumn(): void {
		this.columns++;
		for (const row of this.rows) { row.push(''); }
		this.renderDraft({ row: 0, column: this.columns - 1 });
	}

	private async save(): Promise<void> {
		try {
			const resource = await this.dialogs.showSaveDialog({
				title: localize({ bundle: 'ash.artifacts', key: 'saveCsv' }, 'Save as CSV'),
				filters: [{ name: 'CSV', extensions: ['csv'] }],
			});
			if (!resource || this.isDisposed) { return; }
			const content = this.rows.map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n');
			await this.files.writeFile({ resource, content });
		} catch (error) {
			this.notifications.error(error instanceof Error ? error : String(error));
		}
	}

	public create(container: HTMLElement): void { container.append(this.domNode); }
	public setVisible(_visible: boolean): void { }
	public layout(_dimension: IDimension): void { }
	public focus(): void { this.domNode.focus(); }
	public getAccessibleContent(): string {
		if (!this.example) return this.rows.map(row => row.join('\t')).join('\n');
		return [
			this.example.detail,
			...(this.example.summary?.map(({ label, value }) => `${label}: ${value}`) ?? []),
			this.example.columns.join('\t'),
			...this.example.rows.map(row => row.join('\t')),
		].join('\n');
	}
}

function getColumnName(column: number): string {
	let name = '';
	for (let index = column + 1; index > 0; index = Math.floor((index - 1) / 26)) {
		name = String.fromCharCode(65 + (index - 1) % 26) + name;
	}
	return name;
}

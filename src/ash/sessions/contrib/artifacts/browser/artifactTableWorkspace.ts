import './artifactTableWorkspace.css';
import { h, type IDimension } from '../../../../base/browser/dom.js';
import { Action } from '../../../../base/common/actions.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ArtifactTableDraft } from './artifactTableDrafts.js';
import type { TableArtifactExample } from './artifactExamples.js';
import type { IArtifactWorkspace } from './artifactWorkspaceRegistry.js';

export class ArtifactTableWorkspace extends Disposable implements IArtifactWorkspace {
	public readonly domNode: HTMLElement;
	public readonly usesCanvasPanels = false;
	public readonly toolbarActions: readonly Action[];
	private readonly tableControls = this._register(new DisposableStore());

	constructor(
		ownerDocument: Document,
		private readonly title: string,
		private readonly source: TableArtifactExample | ArtifactTableDraft,
		@IFileDialogService private readonly dialogs: IFileDialogService,
		@IFileService private readonly files: IFileService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		const { kind } = source;
		this.domNode = h(ownerDocument, 'section', {
			className: `ash-artifact-table-workspace ${kind}`,
			attributes: { 'aria-label': title, 'data-creator-mode': kind, tabindex: '0' },
		});
		if (source instanceof ArtifactTableDraft) {
			this.domNode.classList.add('editable');
			const exportCsv = this._register(new Action('sessions.artifacts.table.exportCsv', localize({ bundle: 'ash.artifacts', key: 'exportCsv' }, 'Export CSV'), '', true, () => this.exportCsv(source)));
			exportCsv.icon = Lxicon.export;
			this.toolbarActions = [exportCsv];
			this.renderDraft(source);
		} else {
			this.toolbarActions = [];
			this.renderExample(source);
		}
	}

	private renderExample(example: TableArtifactExample): void {
		const ownerDocument = this.domNode.ownerDocument;
		const sheet = example.kind === 'sheet';
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

	private renderDraft(draft: ArtifactTableDraft, focus?: { row: number; column: number; }): void {
		this.tableControls.clear();
		const document = this.domNode.ownerDocument;
		const table = h(document, 'table', { attributes: { 'aria-label': this.title } });
		const headings = table.createTHead().insertRow();
		headings.append(h(document, 'td'));
		for (let column = 0; column < draft.columnCount; column++) {
			headings.append(h(document, 'th', { attributes: { scope: 'col' } }, getColumnName(column)));
		}
		this.addTableButton(headings.insertCell(), localize({ bundle: 'ash.artifacts', key: 'addColumn' }, 'Add column'), () => {
			draft.addColumn();
			this.renderDraft(draft, { row: 0, column: draft.columnCount - 1 });
		});
		const body = table.createTBody();
		let active: HTMLInputElement | undefined;
		for (const [row, values] of draft.rows.entries()) {
			const line = body.insertRow();
			line.append(h(document, 'th', { attributes: { scope: 'row' } }, String(row + 1)));
			for (const [column, value] of values.entries()) {
				const input = h(document, 'input', {
					properties: { value },
					attributes: { 'aria-label': localize({ bundle: 'ash.artifacts', key: 'cell' }, 'Cell {0}', `${getColumnName(column)}${row + 1}`) },
				});
				input.oninput = () => { draft.setCell(row, column, input.value); };
				line.insertCell().append(input);
				if (focus?.row === row && focus.column === column) active = input;
			}
		}
		const footer = table.createTFoot().insertRow();
		const addRowCell = footer.insertCell();
		addRowCell.colSpan = draft.columnCount + 2;
		this.addTableButton(addRowCell, localize({ bundle: 'ash.artifacts', key: 'addRow' }, 'Add row'), () => {
			draft.addRow();
			this.renderDraft(draft, { row: draft.rows.length - 1, column: 0 });
		});
		this.domNode.replaceChildren(table);
		active?.focus();
	}

	private addTableButton(container: HTMLElement, label: string, onClick: () => void): void {
		const button = this.tableControls.add(new Button(container, { ...defaultButtonStyles, label, title: label, iconOnly: true, size: 'small', onClick }));
		button.icon = Lxicon.add;
	}

	private async exportCsv(draft: ArtifactTableDraft): Promise<void> {
		try {
			const resource = await this.dialogs.showSaveDialog({
				title: localize({ bundle: 'ash.artifacts', key: 'exportCsv' }, 'Export CSV'),
				filters: [{ name: 'CSV', extensions: ['csv'] }],
			});
			if (!resource || this.isDisposed) { return; }
			const content = draft.rows.map(row => row.map(value => `"${value.replaceAll('"', '""')}"`).join(',')).join('\r\n');
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
		const source = this.source;
		if (source instanceof ArtifactTableDraft) return source.rows.map(row => row.join('\t')).join('\n');
		return [
			source.detail,
			...(source.summary?.map(({ label, value }) => `${label}: ${value}`) ?? []),
			source.columns.join('\t'),
			...source.rows.map(row => row.join('\t')),
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

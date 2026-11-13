import './artifactTableEditorWidget.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Table } from '../../../../base/browser/ui/table/tableWidget.js';
import type { ITableColumn, ITableRenderer } from '../../../../base/browser/ui/table/table.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import type { ArtifactTableModel } from '../common/artifactTableModel.js';

interface TableCell { readonly row: number; readonly column: number; readonly value: string; }
interface CellTemplate { readonly input: HTMLInputElement; cell: TableCell | undefined; readonly listeners: DisposableStore; }

/** Artifact cell editing over the shared Table; the model owns all document content. */
export class ArtifactTableEditorWidget extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly tableHost: HTMLElement;
	private readonly table = this._register(new MutableDisposable<Table<number>>());
	private columns = 0;
	private rows = 0;
	private active = { row: 0, column: 0 };
	private readonly deleteRow: Button;
	private readonly deleteColumn: Button;

	constructor(ownerDocument: Document, title: string, private readonly source: ArtifactTableModel) {
		super();
		this.domNode = h(ownerDocument, 'section', {
			className: `ash-artifact-table-editor ${source.kind}`,
			attributes: { 'aria-label': title, 'data-creator-mode': source.kind },
		});
		this._register(toDisposable(() => this.domNode.remove()));
		const controls = h(ownerDocument, 'div', { className: 'ash-artifact-table-controls', attributes: { role: 'group', 'aria-label': title } });
		const addButton = (label: string, run: () => void) => this._register(new Button(controls, { ...defaultButtonStyles, label, title: label, presentation: 'secondary', size: 'small', onClick: run }));
		addButton(localize({ bundle: 'ash.artifacts', key: 'addRow' }, 'Add row'), () => {
			source.addRow(); this.focusCell(source.rows.length - 1, this.active.column);
		});
		addButton(localize({ bundle: 'ash.artifacts', key: 'addColumn' }, 'Add column'), () => {
			source.addColumn(); this.focusCell(this.active.row, source.columnCount - 1);
		});
		this.deleteRow = addButton(localize({ bundle: 'ash.artifacts', key: 'deleteRow' }, 'Delete row'), () => {
			source.deleteRow(this.active.row); this.focusCell(this.active.row, this.active.column);
		});
		this.deleteColumn = addButton(localize({ bundle: 'ash.artifacts', key: 'deleteColumn' }, 'Delete column'), () => {
			source.deleteColumn(this.active.column); this.focusCell(this.active.row, this.active.column);
		});
		this.tableHost = h(ownerDocument, 'div', { className: 'ash-artifact-table-content' });
		this.domNode.append(controls, this.tableHost);
		this._register(autorun(reader => {
			source.version.read(reader);
			this.render();
			this.deleteRow.enabled = source.rows.length > 1;
			this.deleteColumn.enabled = source.columnCount > 1;
		}));
	}

	private render(): void {
		const title = this.domNode.getAttribute('aria-label')!;
		const source = this.source;
		if (this.columns !== source.columnCount) {
			this.table.clear();
			this.columns = source.columnCount;
			const columns: ITableColumn<number, unknown>[] = [{
				label: '#', weight: .4, minimumWidth: 44, maximumWidth: 64, templateId: 'rowNumber', project: row => row + 1,
			}];
			for (let column = 0; column < source.columnCount; column++) {
				columns.push({
					label: getColumnName(column), weight: 1, minimumWidth: 100, templateId: 'cell',
					project: row => ({ row, column, value: source.rows[row][column] })
				});
			}
			const renderer: ITableRenderer<TableCell, CellTemplate> = {
				templateId: 'cell',
				renderTemplate: container => {
					const input = h(container.ownerDocument, 'input');
					container.append(input);
					const template: CellTemplate = { input, cell: undefined, listeners: new DisposableStore() };
					template.listeners.add(addDisposableListener(input, 'input', () => {
						const cell = template.cell!;
						source.setCell(cell.row, cell.column, input.value);
					}));
					template.listeners.add(addDisposableListener(input, 'focus', () => {
						const { row, column } = template.cell!;
						this.active = { row, column };
					}));
					template.listeners.add(addDisposableListener(input, 'keydown', event => this.onKeyDown(event, template.cell!)));
					template.listeners.add(addDisposableListener(input, 'paste', event => this.onPaste(event, template.cell!)));
					return template;
				},
				renderElement: (cell, _index, template) => {
					template.cell = cell;
					if (template.input.value !== cell.value) template.input.value = cell.value;
					template.input.dataset.row = String(cell.row);
					template.input.dataset.column = String(cell.column);
					template.input.setAttribute('aria-label', localize({ bundle: 'ash.artifacts', key: 'cell' }, 'Cell {0}', `${getColumnName(cell.column)}${cell.row + 1}`));
				},
				disposeTemplate: template => template.listeners.dispose(),
			};
			const rowNumbers: ITableRenderer<number, HTMLElement> = {
				templateId: 'rowNumber', renderTemplate: container => container,
				renderElement: (value, _index, container) => { container.textContent = String(value); }, disposeTemplate: () => { },
			};
			this.table.value = new Table('ArtifactTableEditor', this.tableHost, { headerRowHeight: 32, getHeight: () => 36 }, columns,
				[renderer as ITableRenderer<unknown, unknown>, rowNumbers as ITableRenderer<unknown, unknown>], { ariaLabel: title, identityProvider: { getId: row => String(row) } });
			this.rows = 0;
		}
		if (this.rows !== source.rows.length) {
			this.table.value!.splice(0, this.rows, source.rows.map((_, index) => index));
			this.rows = source.rows.length;
		} else this.table.value!.rerender();
	}

	private onKeyDown(event: KeyboardEvent, cell: TableCell): void {
		if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
		let row = cell.row, column = cell.column;
		switch (event.key) {
			case 'ArrowDown': row++; break;
			case 'ArrowUp': row--; break;
			case 'Enter': row += event.shiftKey ? -1 : 1; break;
			case 'Tab': {
				const next = row * this.columns + column + (event.shiftKey ? -1 : 1);
				// At the edges Tab leaves the grid so all document controls remain reachable.
				if (next < 0) { event.preventDefault(); this.deleteColumn.domNode.focus(); return; }
				if (next >= this.rows * this.columns) return;
				row = Math.floor(next / this.columns); column = next % this.columns; break;
			}
			default: return;
		}
		event.preventDefault();
		this.focusCell(row, column);
	}

	private onPaste(event: ClipboardEvent, cell: TableCell): void {
		const text = event.clipboardData?.getData('text/plain');
		if (text === undefined) return;
		const normalized = text.replace(/\r\n?/gu, '\n');
		if (!/[\t\n]/u.test(normalized)) return;
		event.preventDefault();
		if (text.length > 1_000_000) {
			status(localize({ bundle: 'ash.artifacts', key: 'tablePasteTooLarge' }, 'The pasted table is too large.'));
			return;
		}
		const values = normalized.replace(/\n$/u, '').split('\n').map(line => line.split('\t'));
		const width = values.reduce((width, line) => Math.max(width, line.length), 0);
		if (Math.max(this.rows, cell.row + values.length) * Math.max(this.columns, cell.column + width) > 100_000) {
			status(localize({ bundle: 'ash.artifacts', key: 'tablePasteTooLarge' }, 'The pasted table is too large.'));
			return;
		}
		this.source.setCells(cell.row, cell.column, values);
		this.focusCell(cell.row, cell.column);
	}

	private focusCell(row: number, column: number): void {
		this.active = { row: Math.max(0, Math.min(row, this.rows - 1)), column: Math.max(0, Math.min(column, this.columns - 1)) };
		const input = this.tableHost.querySelector<HTMLInputElement>(`input[data-row="${this.active.row}"][data-column="${this.active.column}"]`);
		input?.focus();
		input?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
	}
	public layout(width: number): void { this.table.value?.layout(undefined, width); }
	public setTitle(title: string): void {
		this.domNode.setAttribute('aria-label', title);
		this.table.value?.domNode.setAttribute('aria-label', title);
	}
	public focus(): void { this.focusCell(this.active.row, this.active.column); }
	public getAccessibleContent(): string { return this.source.rows.map(row => row.join('\t')).join('\n'); }
}

function getColumnName(column: number): string {
	let name = '';
	for (let index = column + 1; index > 0; index = Math.floor((index - 1) / 26)) {
		name = String.fromCharCode(65 + (index - 1) % 26) + name;
	}
	return name;
}

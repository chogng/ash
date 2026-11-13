import { observableValue, type IObservable } from '../../../../base/common/observable.js';

export type ArtifactTableKind = 'sheet' | 'data';

export class ArtifactTableModel {
	private readonly titleValue;
	private readonly versionValue = observableValue(this, 0);
	public readonly version: IObservable<number> = this.versionValue;
	public readonly title: IObservable<string | undefined>;

	constructor(
		public readonly id: string,
		public readonly kind: ArtifactTableKind,
		private readonly cells: string[][],
		public revision: string | undefined,
		private readonly onChange: (draft: ArtifactTableModel) => void,
		title?: string,
		public readonly createdAt?: number,
	) {
		this.titleValue = observableValue(this, title);
		this.title = this.titleValue;
	}

	public get rows(): readonly (readonly string[])[] { return this.cells; }
	public get columnCount(): number { return this.cells[0].length; }

	public rename(title: string): void {
		this.titleValue.set(title, undefined);
		this.changed();
	}

	public setCell(row: number, column: number, value: string): void {
		if (this.cells[row][column] === value) { return; }
		this.cells[row][column] = value;
		this.changed();
	}

	/** Applies a rectangular clipboard block as one model change and save request. */
	public setCells(row: number, column: number, values: readonly (readonly string[])[]): void {
		const width = Math.max(this.columnCount, column + values.reduce((width, line) => Math.max(width, line.length), 0));
		while (this.cells.length < row + values.length) this.cells.push(Array<string>(this.columnCount).fill(''));
		for (const line of this.cells) while (line.length < width) line.push('');
		for (const [offset, line] of values.entries()) {
			for (const [cell, value] of line.entries()) this.cells[row + offset][column + cell] = value;
		}
		this.changed();
	}

	public deleteRow(row: number): void {
		if (this.cells.length === 1) return;
		this.cells.splice(row, 1);
		this.changed();
	}

	public deleteColumn(column: number): void {
		if (this.columnCount === 1) return;
		for (const line of this.cells) line.splice(column, 1);
		this.changed();
	}

	private changed(): void {
		this.versionValue.set(this.versionValue.get() + 1, undefined);
		this.onChange(this);
	}

	public addRow(): void {
		this.cells.push(Array<string>(this.columnCount).fill(''));
		this.changed();
	}

	public addColumn(): void {
		for (const row of this.cells) { row.push(''); }
		this.changed();
	}
}

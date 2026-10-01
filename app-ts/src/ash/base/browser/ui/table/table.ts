import type { Event } from '../../../common/event.js';

export interface ITableColumn<TRow, TCell> {
	readonly label: string;
	readonly tooltip?: string;
	readonly weight: number;
	readonly templateId: string;
	readonly minimumWidth?: number;
	readonly maximumWidth?: number;
	readonly onDidChangeWidthConstraints?: Event<void>;
	project(row: TRow): TCell;
}

export interface ITableVirtualDelegate<TRow> {
	readonly headerRowHeight: number;
	getHeight(row: TRow): number;
}

export interface ITableRenderer<TCell, TTemplateData> {
	readonly templateId: string;
	renderTemplate(container: HTMLElement): TTemplateData;
	renderElement(element: TCell, index: number, templateData: TTemplateData): void;
	disposeElement?(element: TCell, index: number, templateData: TTemplateData): void;
	disposeTemplate(templateData: TTemplateData): void;
}

export interface ITableEvent<TRow> {
	readonly elements: readonly TRow[];
	readonly indexes: readonly number[];
	readonly browserEvent?: UIEvent;
}

export class TableError extends Error {
	constructor(user: string, message: string) {
		super(`TableError [${user}] ${message}`);
	}
}

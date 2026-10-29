import { getActiveDocument, h } from '../../dom.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../common/lifecycle.js';
import type { IListRenderer } from './list.js';

export interface IRow {
	domNode: HTMLElement;
	templateId: string;
	templateData: any;
}

/** Owns templates; element identity and per-element resources belong to the list. */
export class RowCache<T> extends Disposable {
	private readonly available = new Map<string, IRow[]>();
	private readonly pendingRemoval = new Set<IRow>();
	private readonly templates = this._register(new DisposableMap<IRow, DisposableStore>());
	private transactionDepth = 0;

	constructor(
		private readonly renderers: Map<string, IListRenderer<T, any>>,
		private readonly document: Document = getActiveDocument(),
	) {
		super();
		this._register(toDisposable(() => {
			this.available.clear();
			this.pendingRemoval.clear();
		}));
	}

	alloc(templateId: string): { row: IRow; isReusingConnectedDomNode: boolean; } {
		let row = this.available.get(templateId)?.pop();
		if (row) {
			this.pendingRemoval.delete(row);
		} else {
			const renderer = this.renderers.get(templateId);
			if (!renderer) throw new Error(`Unknown list template: ${templateId}`);
			const domNode = h(this.document, 'div');
			row = { domNode, templateId, templateData: renderer.renderTemplate(domNode) };
			const template = row;
			const resources = new DisposableStore();
			resources.add(toDisposable(() => {
				template.domNode.remove();
				renderer.disposeTemplate(template.templateData);
			}));
			this.templates.set(template, resources);
		}
		return { row, isReusingConnectedDomNode: row.domNode.isConnected };
	}

	release(row: IRow): void {
		let rows = this.available.get(row.templateId);
		if (!rows) {
			rows = [];
			this.available.set(row.templateId, rows);
		}
		rows.push(row);
		if (this.transactionDepth > 0) this.pendingRemoval.add(row);
		else row.domNode.remove();
	}

	transact(makeChanges: () => void): void {
		// Keep released DOM attached until the batch has had a chance to reuse its template.
		this.transactionDepth++;
		try {
			makeChanges();
		} finally {
			this.transactionDepth--;
			if (this.transactionDepth === 0) {
				for (const row of this.pendingRemoval) row.domNode.remove();
				this.pendingRemoval.clear();
			}
		}
	}
}

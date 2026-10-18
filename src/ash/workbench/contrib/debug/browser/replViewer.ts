import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import type { IListRenderer } from '../../../../base/browser/ui/list/list.js';
import type { AsyncTreeDataSource } from '../../../../base/browser/ui/tree/tree.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import type { DebugConsoleEntry } from '../../../../platform/debug/common/debugAdapterProcessService.js';
import { localize } from '../../../../nls.js';
import { IDebugService, type IReplModel } from '../common/debug.js';

interface ReplTreeElement {
	readonly id: string;
	readonly entry: DebugConsoleEntry;
	readonly entries: readonly DebugConsoleEntry[];
	readonly visible: readonly boolean[];
	readonly text: string;
	readonly kind: 'entry' | 'variable' | 'data';
	readonly reference: number;
	readonly depth: number;
}

/** Reads immutable log snapshots and inspection results; the tree owns loaded children. */
export class ReplDataSource implements AsyncTreeDataSource<IReplModel, ReplTreeElement> {
	private readonly identities = new Map<string, { key: string; element: ReplTreeElement; }>();
	constructor(private readonly entries: () => readonly DebugConsoleEntry[],
		private readonly visible: (entry: DebugConsoleEntry) => boolean,
		@IDebugService private readonly debugService: IDebugService,
	) { }

	hasChildren(element: IReplModel | ReplTreeElement): boolean {
		if (!('entry' in element)) return true;
		return element.kind === 'entry' && (element.entry.kind === 'group' || element.entry.data !== null)
			|| element.reference > 0 && element.depth < 16;
	}

	async getChildren(element: IReplModel | ReplTreeElement): Promise<ReplTreeElement[]> {
		if (!('entry' in element) || element.kind === 'entry' && element.entry.kind === 'group') {
			const entries = this.entries();
			if (!('entry' in element)) {
				const retained = new Set(entries.map(entry => `${entry.sessionId}:${entry.id}`));
				for (const id of this.identities.keys()) if (!retained.has(id)) this.identities.delete(id);
			}
			const parentId = 'entry' in element ? element.entry.id : null;
			const lines: DebugConsoleEntry[][] = [];
			for (const entry of entries.filter(entry => entry.parentId === parentId)) {
				const previous = lines.at(-1)?.at(-1);
				const plain = (value: DebugConsoleEntry) => value.kind === 'output' && !value.source && !value.variablesReference && value.data === null;
				if (previous && plain(previous) && plain(entry) && previous.category === entry.category && !previous.output.endsWith('\n')) lines.at(-1)!.push(entry);
				else lines.push([entry]);
			}
			return lines.map(entries => {
				const entry = entries[0]!;
				const id = `${entry.sessionId}:${entry.id}`;
				const visible = entries.map(this.visible);
				const key = JSON.stringify([entries, visible]);
				const existing = this.identities.get(id);
				if (existing?.key === key) return existing.element;
				const text = entries.filter((_, index) => visible[index]).map(entry => entry.output || (entry.kind === 'group' || entry.variablesReference || entry.data !== null ? localize('debug.repl.object', 'Object') : '')).join('');
				const element: ReplTreeElement = { id, entry, entries, visible, text, kind: 'entry', reference: entry.variablesReference ?? 0, depth: 0 };
				this.identities.set(id, { key, element });
				return element;
			});
		}
		const children: ReplTreeElement[] = [];
		if (element.kind === 'entry' && element.entry.data !== null) {
			children.push({ ...element, id: `${element.id}/data`, kind: 'data', text: JSON.stringify(element.entry.data, null, 2), reference: 0 });
		}
		if (!element.reference || element.depth >= 16) return children;

		try {
			const session = this.debugService.getSession(element.entry.sessionId);
			if (!session || session.state === 'terminated' || session.state === 'error') throw new Error(localize('debug.repl.sessionEnded', 'The debug session has ended.'));
			// The inspection revision belongs to the originating output, even for a nested variable.
			const values = await session.variables(element.reference, element.entry.inspectionRevision ?? undefined);
			if (this.debugService.getSession(session.id) !== session) {
				if (!children.length) return [];
				throw new Error(localize('debug.repl.sessionEnded', 'The debug session has ended.'));
			}
			return [...children, ...values.map((value, index) => ({
				id: `${element.id}/${index}:${encodeURIComponent(value.name)}`, entry: element.entry, entries: element.entries, visible: element.visible,
				kind: 'variable' as const, text: `${value.name}: ${value.value}`,
				reference: value.variablesReference, depth: element.depth + 1,
			}))];
		} catch (error) {
			if (!children.length) throw error;
			// Retained JSON is independent of the live inspection reference. Keep it
			// readable and expose the failed dynamic read as a separate, terminal row.
			return [...children, { ...element, id: `${element.id}/error`, kind: 'data', text: error instanceof Error ? error.message : String(error), reference: 0 }];
		}

	}
}

/** Accessibility text for Rust-owned output and lazily inspected tree children. */
export class ReplAccessibilityProvider {
	getWidgetAriaLabel(): string { return localize('debug.repl.output', 'Debug Console output'); }
	getAriaLabel(element: ReplTreeElement): string {
		return element.text + (element.kind === 'entry' && element.entry.source ? sourceLabel(element.entry) : '');
	}
}

/** Owns one row's text/source control; expansion and child lifetimes belong to AsyncDataTree. */
export class ReplOutputElementRenderer extends Disposable implements IListRenderer<ReplTreeElement, ReturnType<ReplOutputElementRenderer['renderTemplate']>> {
	readonly templateId = 'replOutput';
	private readonly accessibility = new ReplAccessibilityProvider();
	private readonly templates = new Map<HTMLElement, { element: HTMLElement; disposables: DisposableStore; }>();
	constructor(private readonly source: (entry: DebugConsoleEntry) => Promise<void>) { super(); }

	renderTemplate(container: HTMLElement) {
		const element = h(container.ownerDocument, 'div');
		element.className = 'ash-repl-row-content';
		container.append(element);
		const template = { element, disposables: new DisposableStore() };
		this.templates.set(element, template);
		return template;
	}

	renderElement(node: ReplTreeElement, _index: number, template: ReturnType<ReplOutputElementRenderer['renderTemplate']>): void {
		const row = template.element;
		row.dataset.category = node.entry.category;
		row.setAttribute('aria-label', this.accessibility.getAriaLabel(node));
		if (node.kind === 'entry') {
			for (const [index, entry] of node.entries.entries()) {
				const chunk = h(row.ownerDocument, 'span');
				chunk.className = 'ash-repl-entry';
				chunk.dataset.entryId = String(entry.id);
				chunk.dataset.category = entry.category;
				chunk.hidden = !node.visible[index];
				chunk.textContent = entry.output || (node.entries.length === 1 ? node.text : '');
				row.append(chunk);
			}
		} else row.append(row.ownerDocument.createTextNode(node.text));
		if (node.kind !== 'entry' || !node.entry.source) return;
		const link = h(row.ownerDocument, 'button');
		link.type = 'button';
		link.className = 'ash-repl-source';
		link.textContent = sourceLabel(node.entry);
		template.disposables.add(addDisposableListener(link, 'click', event => {
			event.stopPropagation();
			void this.source(node.entry);
		}));
		template.disposables.add(addDisposableListener(link, 'keydown', event => {
			// Let the button's default activation run without the tree consuming Enter or Space.
			if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
		}));
		row.append(link);
	}

	disposeTemplate(template: ReturnType<ReplOutputElementRenderer['renderTemplate']>): void {
		template.disposables.dispose();
		this.templates.delete(template.element);
	}

	override dispose(): void {
		for (const template of this.templates.values()) template.disposables.dispose();
		this.templates.clear();
		super.dispose();
	}
}

function sourceLabel(entry: DebugConsoleEntry): string {
	const source = entry.source as { readonly name?: string; readonly path?: string; };
	return localize('debug.repl.sourceLabel', '{0}:{1}', source.name ?? source.path ?? localize('debug.repl.source', 'Source'), entry.line ?? 1);
}

import './media/processExplorer.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import type { ObjectTreeElement } from '../../../../base/browser/ui/tree/objectTreeModel.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import type { ProcessItem } from '../../../../base/common/processes.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { IProcessService } from '../../../../platform/process/common/process.js';

export const ProcessExplorerFocusedContext = new RawContextKey<boolean>('processExplorerFocused', false);

interface ProcessRow {
	readonly id: string;
	readonly name: string;
	readonly process?: ProcessItem;
}

/** Owns the displayed snapshot; Main owns collection and the tree owns navigation state. */
export class ProcessExplorerControl extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly tree: WorkbenchObjectTree<ProcessRow>;
	private readonly toolbar: WorkbenchToolBar;
	private readonly statusDomNode: HTMLElement;
	private readonly rowResources = this._register(new DisposableMap<HTMLElement, IDisposable>());
	private readonly inputResources = this._register(new DisposableStore());
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeContent = this.changed.event;
	private rows: readonly ObjectTreeElement<ProcessRow>[] = [];
	private inputSignal: AbortSignal | undefined;
	private generation = 0;
	private loading = false;

	constructor(
		container: HTMLElement,
		@IProcessService private readonly processes: IProcessService,
		@IConfigurationService configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IContextMenuService menus: IContextMenuService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
		@IHoverService private readonly hover: IHoverService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-process-explorer';
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		const scope = this._register(contextKeys.createScoped(this.domNode));
		const focused = ProcessExplorerFocusedContext.bindTo(scope);
		this._register(addDisposableListener(this.domNode, 'focusin', () => focused.set(true)));
		this._register(addDisposableListener(this.domNode, 'focusout', event => {
			if (!this.domNode.contains(event.relatedTarget as Node | null)) { focused.set(false); }
		}));
		const header = h(container.ownerDocument, 'div');
		header.className = 'process-explorer-toolbar';
		this.domNode.append(header);
		this.toolbar = this._register(new WorkbenchToolBar(header, menus, { ariaLabel: localize('processExplorer.actions', 'Process explorer actions') }));
		const columns = h(container.ownerDocument, 'div');
		columns.className = 'process-explorer-columns';
		for (const label of this.columnLabels()) { const column = h(container.ownerDocument, 'span'); column.textContent = label; columns.append(column); }
		this.domNode.append(columns);
		this.tree = this._register(new WorkbenchObjectTree<ProcessRow>(this.domNode, {
			configurationService: configuration,
			modelOptions: { identityProvider: { getId: row => row.id }, defaultCollapseState: 'expanded' },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: row => row.name },
			multipleSelectionSupport: false,
			onDidRemoveRow: row => {
				const rendered = row.querySelector<HTMLElement>('.process-explorer-row');
				if (rendered) { this.rowResources.deleteAndDispose(rendered); }
			},
			renderElement: row => this.renderRow(row),
		}));
		this.tree.domNode.classList.add('process-explorer-tree');
		this.statusDomNode = h(container.ownerDocument, 'div');
		this.statusDomNode.className = 'process-explorer-status';
		this.statusDomNode.setAttribute('role', 'status');
		this.statusDomNode.tabIndex = 0;
		this.domNode.append(this.statusDomNode);
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.ProcessExplorer)) { this.updateAriaLabel(); }
		}));
		this.updateAriaLabel();
		this.updateActions();
	}

	public async setInput(signal: AbortSignal): Promise<void> {
		this.clearInput();
		signal.throwIfAborted();
		this.inputSignal = signal;
		const abort = (): void => this.clearInput();
		signal.addEventListener('abort', abort, { once: true });
		this.inputResources.add(toDisposable(() => signal.removeEventListener('abort', abort)));
		await this.refresh();
	}

	public clearInput(): void {
		this.generation++;
		this.inputSignal = undefined;
		this.inputResources.clear();
		this.loading = false;
		this.rows = [];
		this.tree.setChildren([]);
		this.statusDomNode.textContent = '';
		this.updateActions();
	}

	public focus(): void {
		if (this.rows.length) { this.tree.domFocus(); }
		else { this.statusDomNode.focus(); }
	}

	public async refresh(): Promise<void> {
		if (this.isDisposed || !this.inputSignal || this.inputSignal.aborted || this.loading) { return; }
		const generation = ++this.generation;
		this.loading = true;
		this.statusDomNode.textContent = localize('processExplorer.loading', 'Loading processes…');
		this.updateActions();
		try {
			const snapshot = await this.processes.resolveProcesses();
			if (!this.isCurrent(generation)) { return; }
			const names = new Map(snapshot.pidToNames);
			const rows: ObjectTreeElement<ProcessRow>[] = [];
			const errors: string[] = [];
			let count = 0;
			const collect = (item: ProcessItem, group: number): ObjectTreeElement<ProcessRow> => {
				count++;
				return { element: { id: `${group}:${item.pid}`, name: names.get(item.pid) ?? item.name, process: item }, children: item.children?.map(child => collect(child, group)) };
			};
			for (const [index, group] of snapshot.processes.entries()) {
				if ('errorMessage' in group.rootProcess) { errors.push(`${group.name}: ${group.rootProcess.errorMessage}`); continue; }
				rows.push({ element: { id: `group:${index}`, name: group.name }, children: [collect(group.rootProcess, index)] });
			}
			this.rows = rows;
			this.tree.setChildren(rows);
			this.statusDomNode.textContent = errors.length ? localize('processExplorer.partial', 'Some processes could not be loaded: {0}', errors.join('; ')) : localize('processExplorer.count', '{0} processes. Metrics reflect the last refresh.', count);
			status(this.statusDomNode.textContent);
		} catch {
			if (!this.isCurrent(generation)) { return; }
			// Keep the last successful snapshot readable without presenting it as current.
			this.statusDomNode.textContent = localize('processExplorer.failed', 'Could not refresh processes. Any displayed metrics are from the previous refresh. Try Refresh again.');
			status(this.statusDomNode.textContent);
		} finally {
			if (this.isCurrent(generation)) { this.loading = false; this.updateActions(); this.changed.fire(); }
		}
	}

	public getAccessibleContent(): string {
		const lines = [this.columnLabels().join('\t')];
		const append = (rows: readonly ObjectTreeElement<ProcessRow>[], depth: number): void => {
			for (const row of rows) { lines.push('  '.repeat(depth) + this.rowValues(row.element).join('\t')); if (row.children) { append(row.children, depth + 1); } }
		};
		append(this.rows, 0);
		lines.push(this.statusDomNode.textContent ?? '');
		return lines.join('\n');
	}

	private isCurrent(generation: number): boolean { return !this.isDisposed && generation === this.generation && Boolean(this.inputSignal && !this.inputSignal.aborted); }
	private columnLabels(): readonly string[] { return [localize('processExplorer.process', 'Process'), localize('processExplorer.cpu', 'CPU %'), localize('processExplorer.memory', 'RSS MiB'), localize('processExplorer.pid', 'PID')]; }
	private rowValues(row: ProcessRow): readonly string[] { return row.process ? [row.name, row.process.load.toFixed(1), (row.process.mem / 2 ** 20).toFixed(1), String(row.process.pid)] : [row.name, '', '', '']; }
	private renderRow(row: ProcessRow): HTMLElement {
		const domNode = h(this.domNode.ownerDocument, 'div');
		domNode.className = 'process-explorer-row';
		domNode.setAttribute('aria-label', row.process ? localize('processExplorer.row', '{0}, PID {1}, CPU {2} percent, resident memory {3} MiB', row.name, row.process.pid, row.process.load.toFixed(1), (row.process.mem / 2 ** 20).toFixed(1)) : row.name);
		for (const value of this.rowValues(row)) { const cell = h(this.domNode.ownerDocument, 'span'); cell.textContent = value; domNode.append(cell); }
		this.rowResources.set(domNode, this.hover.setupDelayedHover(domNode.firstElementChild as HTMLElement, { content: row.name }));
		return domNode;
	}
	private updateAriaLabel(): void {
		const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.ProcessExplorer);
		this.tree.domNode.setAttribute('aria-label', [localize('processExplorer.title', 'Process Explorer'), hint].filter(Boolean).join('. '));
	}
	private updateActions(): void {
		this.tree.domNode.setAttribute('aria-busy', String(this.loading));
		const refreshLabel = localize('processExplorer.refresh', 'Refresh');
		const copyLabel = localize('processExplorer.copy', 'Copy process information');
		// Refresh stays focusable while a request is pending; refresh() coalesces repeated activations.
		this.toolbar.setActions([
			{ id: 'processExplorer.refresh', label: refreshLabel, tooltip: refreshLabel, icon: Lxicon.refresh, enabled: Boolean(this.inputSignal), run: () => this.refresh() },
			{
				id: 'processExplorer.copy', label: copyLabel, tooltip: copyLabel, icon: Lxicon.copy, enabled: this.rows.length > 0, run: async () => {
					const generation = this.generation;
					try { await this.clipboard.writeText(this.getAccessibleContent()); }
					catch { if (this.isCurrent(generation)) { this.statusDomNode.textContent = localize('processExplorer.copyFailed', 'Could not copy process information.'); status(this.statusDomNode.textContent); this.changed.fire(); } }
				}
			},
		]);
	}
}

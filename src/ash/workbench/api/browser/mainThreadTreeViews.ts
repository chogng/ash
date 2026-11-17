import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import Severity from '../../../base/common/severity.js';
import { URI, isUriComponents } from '../../../base/common/uri.js';
import type { CancellationToken } from '../../../base/common/cancellation.js';
import { VSDataTransfer, createStringDataTransferItem } from '../../../base/common/dataTransfer.js';
import { localize } from '../../../nls.js';
import { IExtensionHostApi, type ExtensionClientSource, type ExtensionHostFleetSnapshot, type ExtensionHostTreeDataProviderRegistration, type JsonValue } from '../../../platform/extensions/common/extensionHostApi.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../platform/instantiation/common/descriptors.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { TreeView, TreeViewPane } from '../../browser/parts/views/treeView.js';
import { IViewDescriptorService, TreeItemCollapsibleState, ViewContainerLocation, type ITreeItem, type ITreeViewOptions } from '../../common/views.js';
import { IViewsService } from '../../services/views/common/viewsService.js';
import type { ExtensionApiIssue } from './mainThreadExtensionApi.js';

interface TreeBinding extends DisposableStore {
	readonly identity: string;
	readonly source: ExtensionClientSource;
	readonly tree: TreeView;
	refresh(handles?: readonly string[]): void;
	getItem(handle: string): ITreeItem | undefined;
	configure(options: TreePresentationOptions): void;
}

/** Converts admitted process callbacks into window-owned view registrations and domain nodes. */
export class MainThreadTreeViews extends Disposable {
	private readonly bindings = this._register(new DisposableMap<string, TreeBinding>());

	constructor(
		private readonly timeout: number,
		@IExtensionHostApi private readonly api: IExtensionHostApi,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IViewDescriptorService private readonly descriptors: IViewDescriptorService,
		@INotificationService private readonly notifications: INotificationService,
		@IViewsService private readonly views: IViewsService,
	) { super(); }

	public update(snapshot: ExtensionHostFleetSnapshot): readonly ExtensionApiIssue[] {
		const issues: ExtensionApiIssue[] = [];
		const active = new Map<string, string>();
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'ready' || runtime.incarnation === undefined) { continue; }
			for (const registration of runtime.registrations) {
				if (registration.kind === 'treeDataProvider') {
					active.set(`${runtime.id}\0${registration.registrationId}`, JSON.stringify([runtime.incarnation, runtime.activationGeneration, registration]));
				}
			}
		}
		for (const [key, binding] of this.bindings) {
			if (active.get(key) !== binding.identity) { this.bindings.deleteAndDispose(key); }
		}
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'ready' || runtime.incarnation === undefined) { continue; }
			for (const registration of runtime.registrations) {
				if (registration.kind !== 'treeDataProvider') { continue; }
				const key = `${runtime.id}\0${registration.registrationId}`;
				if (this.bindings.has(key)) { continue; }
				const source = { extensionId: runtime.id, activationGeneration: runtime.activationGeneration, incarnation: runtime.incarnation };
				try {
					this.bindings.set(key, this.createBinding(registration, source, active.get(key)!));
				} catch (error) {
					// One window may lack an extension's container. Keep projecting the rest
					// of the fleet and retry this registration on the next snapshot.
					issues.push({ extensionId: runtime.id, registrationId: registration.registrationId, message: error instanceof Error ? error.message : String(error) });
				}
			}
		}
		return issues;
	}

	private createBinding(registration: ExtensionHostTreeDataProviderRegistration, source: ExtensionClientSource, identity: string): TreeBinding {
		const container = registration.containerId
			? this.descriptors.getViewContainerById(registration.containerId)
			: this.descriptors.getDefaultViewContainer(ViewContainerLocation.Sidebar);
		if (!container) { throw new Error(`No container for tree view: ${registration.viewId}`); }
		const tree = this.instantiation.createInstance(TreeView, registration.viewId, registration.title);
		const binding = Object.assign(new DisposableStore(), {
			identity, source, tree, refresh: (handles?: readonly string[]) => {
				// A changed item's presentation comes from its parent's children response.
				const parents = handles?.map(handle => records.get(handle)?.parent);
				void tree.refresh(parents?.every((parent): parent is ITreeItem => parent !== undefined) ? [...new Set(parents)] : undefined);
			}, getItem: (handle: string) => records.get(handle), configure: (options: TreePresentationOptions) => {
				const { dragMimeTypes, dropMimeTypes, ...presentation } = options;
				if (dragMimeTypes) { controller.dragMimeTypes = dragMimeTypes; }
				if (dropMimeTypes) { controller.dropMimeTypes = dropMimeTypes; }
				tree.configure(presentation);
			}
		});
		const lifetime = new AbortController();
		binding.add(toDisposable(() => lifetime.abort()));
		const records = new Map<string, ITreeItem>();
		const children = new Map<string | undefined, Set<string>>();
		binding.add(toDisposable(() => { records.clear(); children.clear(); }));
		const retire = (handle: string): void => {
			for (const child of children.get(handle) ?? []) { retire(child); }
			children.delete(handle);
			records.delete(handle);
		};
		const invoke = async (payload: JsonValue, readSignal?: AbortSignal): Promise<JsonValue> => {
			const signal = readSignal ? AbortSignal.any([lifetime.signal, readSignal]) : lifetime.signal;
			signal.throwIfAborted();
			const value = await this.api.invoke({
				...source, registrationId: registration.registrationId, operation: 'tree', payload,
				deadlineUnixMillis: Date.now() + this.timeout,
			}, signal);
			signal.throwIfAborted();
			return value;
		};
		const invokeCancellable = async (payload: JsonValue, token: CancellationToken) => {
			const abort = new AbortController();
			if (token.isCancellationRequested) { abort.abort(); }
			const listener = token.onCancellationRequested(() => abort.abort());
			try { return await invoke(payload, abort.signal); }
			finally { listener.dispose(); }
		};
		const controller = tree.dragAndDropController = {
			dragMimeTypes: [] as string[], dropMimeTypes: [] as string[],
			handleDrag: async (handles: string[], _uuid: string, token: CancellationToken) => {
				const data = parseTreeTransfer(await invokeCancellable({ method: 'drag', handles }, token));
				const transfer = new VSDataTransfer();
				for (const [mime, value] of Object.entries(data)) { transfer.replace(mime, createStringDataTransferItem(value)); }
				return transfer;
			},
			handleDrop: async (transfer: VSDataTransfer, target: ITreeItem | undefined, token: CancellationToken) => {
				const data: Record<string, string> = Object.create(null);
				for (const [mime, item] of transfer) { data[mime] = await item.asString(); }
				await invokeCancellable({ method: 'drop', ...(target ? { handle: target.handle } : {}), data: parseTreeTransfer(data) }, token);
				await tree.refresh();
			},
		};
		tree.dataProvider = {
			getChildren: async (parent, signal) => {
				const response = await invoke({ method: 'children', ...(parent ? { handle: parent.handle } : {}) }, signal);
				const items = parseTreeItems(response);
				const handles = new Set(items.map(item => item.handle));
				for (const item of items) {
					if (records.has(item.handle) && records.get(item.handle)!.parentHandle !== parent?.handle || item.handle === parent?.handle) { throw new TypeError('Tree items must have one acyclic parent'); }
				}
				for (const old of children.get(parent?.handle) ?? []) { if (!handles.has(old)) { retire(old); } }
				if (records.size + items.filter(item => !records.has(item.handle)).length > 10000) { throw new RangeError('Tree node quota exceeded'); }
				children.set(parent?.handle, handles);
				return items.map(item => {
					const canonical = Object.assign(records.get(item.handle) ?? {}, item, { parent, parentHandle: parent?.handle }) as ITreeItem;
					records.set(item.handle, canonical);
					return canonical;
				});
			},
			getEditableData: node => ({
				validationMessage: value => value.length > 32768 || value.includes('\0') ? { content: localize('treeView.invalidName', 'The name is too long or contains a null character.'), severity: Severity.Error } : null,
				onFinish: async (value, success) => {
					try {
						if (success) { await invoke({ method: 'rename', handle: node.handle, value }); await tree.refresh(); }
					} finally {
						if (!tree.isDisposed && (!tree.container?.ownerDocument.activeElement || tree.container.ownerDocument.activeElement === tree.container.ownerDocument.body || tree.container.contains(tree.container.ownerDocument.activeElement))) { tree.focus(); }
					}
				},
			}),
		};
		binding.add(tree.onDidChangeCheckboxState(items => {
			void Promise.all(items.map(item => invoke({ method: 'checkbox', handle: item.handle, isChecked: item.checkbox!.isChecked })))
				.catch(error => { if (!lifetime.signal.aborted) { this.notifications.error(error); } })
				.finally(() => { if (!lifetime.signal.aborted) { void tree.refresh(); } });
		}));
		let selectionQueued = false;
		binding.add(tree.onDidChangeSelectionAndFocus(() => {
			if (selectionQueued) { return; }
			selectionQueued = true;
			queueMicrotask(() => {
				selectionQueued = false;
				if (lifetime.signal.aborted) { return; }
				const selection = tree.getSelection().map(item => item.handle);
				const focus = tree.getFocus()?.handle;
				void invoke({ method: 'selection', handles: selection, ...(focus ? { handle: focus } : {}) }).catch(error => { if (!lifetime.signal.aborted) { this.notifications.error(error); } });
			});
		}));
		for (const [event, method] of [[tree.onDidExpandItem, 'expand'], [tree.onDidCollapseItem, 'collapse']] as const) {
			binding.add(event(item => { void invoke({ method, handle: item.handle }).catch(error => { if (!lifetime.signal.aborted) { this.notifications.error(error); } }); }));
		}
		binding.add(tree.onDidChangeVisibility(visible => {
			void invoke({ method: 'visibility', visible }).catch(error => { if (!lifetime.signal.aborted) { this.notifications.error(error); } });
		}));
		try {
			binding.add(this.descriptors.registerViews(container.id, [{ id: registration.viewId, title: registration.title, canToggleVisibility: true, canMoveView: true, ctorDescriptor: new SyncDescriptor(TreeViewPane, [tree]) }]));
			binding.add(tree);
			return binding;
		} catch (error) { binding.dispose(); tree.dispose(); throw error; }
	}

	public handleChange(payload: JsonValue, source: ExtensionClientSource): boolean {
		if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { return false; }
		const input = payload as { readonly [key: string]: JsonValue; };
		if (input.method !== 'treeViewChanged') { return false; }
		if (Object.keys(input).some(key => !['method', 'registrationId', 'handles'].includes(key)) || typeof input.registrationId !== 'string'
			|| input.handles !== undefined && (!Array.isArray(input.handles) || input.handles.length > 10000 || input.handles.some(handle => typeof handle !== 'string' || !handle || handle.length > 1024))) { throw new TypeError('Invalid tree change notification'); }
		const binding = this.bindings.get(`${source.extensionId}\0${input.registrationId}`);
		if (!binding || binding.source.activationGeneration !== source.activationGeneration || binding.source.incarnation !== source.incarnation) { throw new Error('Tree provider has retired'); }
		binding.refresh(input.handles as string[] | undefined);
		return true;
	}

	public clear(): void { this.bindings.clearAndDisposeAll(); }

	public async handleOperation(payload: JsonValue, source: ExtensionClientSource, signal: AbortSignal): Promise<void> {
		if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { throw new TypeError('Invalid tree operation'); }
		const input = payload as { readonly [key: string]: JsonValue; };
		if (input.method !== 'treeViewOperation' || typeof input.registrationId !== 'string' || typeof input.action !== 'string'
			|| Object.keys(input).some(key => !['method', 'registrationId', 'action', 'handles', 'options'].includes(key))) { throw new TypeError('Invalid tree operation'); }
		const key = `${source.extensionId}\0${input.registrationId}`;
		const binding = this.bindings.get(key);
		const assertActive = () => {
			signal.throwIfAborted();
			if (!binding || this.bindings.get(key) !== binding || binding.source.activationGeneration !== source.activationGeneration || binding.source.incarnation !== source.incarnation) { throw new Error('Tree provider has retired'); }
		};
		assertActive();
		const tree = binding!.tree;
		if (input.action === 'configure') {
			if (input.handles !== undefined) { throw new TypeError('Unexpected tree handles'); }
			binding!.configure(parseTreeViewOptions(input.options));
			return;
		}
		if (!['reveal', 'expand', 'select', 'collapseAll'].includes(input.action)) { throw new TypeError('Unsupported tree action'); }
		if (!Array.isArray(input.handles) || input.handles.length > 10000 || input.handles.some(handle => typeof handle !== 'string' || !handle || handle.length > 1024)) { throw new TypeError('Invalid tree handles'); }
		const handles = input.handles as string[];
		const options = input.options as { readonly [key: string]: JsonValue; } | undefined;
		if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['select', 'focus', 'expand'].includes(key))
			|| Object.values(options).some(value => typeof value !== 'boolean'))) { throw new TypeError('Invalid reveal options'); }
		if (input.action !== 'reveal' && options !== undefined) { throw new TypeError('Unexpected reveal options'); }
		await this.views.openView(tree.id, input.action === 'reveal' && options?.focus === true);
		assertActive();
		await tree.refresh([]);
		assertActive();
		const itemFor = (handle: string) => {
			const item = binding!.getItem(handle);
			if (!item) { throw new Error(`Unknown tree item: ${handle}`); }
			return item;
		};
		if (input.action === 'reveal') {
			if (!handles.length || handles.length > 1000) { throw new TypeError('Invalid reveal path'); }
			let parent: ITreeItem | undefined;
			for (let index = 0; index < handles.length; index++) {
				const item = itemFor(handles[index]!);
				if (item.parent !== parent) { throw new TypeError('Invalid reveal ancestry'); }
				if (index < handles.length - 1 || options?.expand) { await tree.expand([item]); assertActive(); }
				parent = item;
			}
			await tree.reveal(parent!);
			assertActive();
			if (options?.select !== false) { tree.setSelection([parent!]); }
			if (options?.focus) { tree.setFocus(parent!); tree.focus(); }
		} else if (input.action === 'expand') { await tree.expand(handles.map(itemFor)); }
		else if (input.action === 'select') { tree.setSelection(handles.map(itemFor)); }
		else { tree.collapseAll(); }
		assertActive();
	}
}

type TreePresentationOptions = ITreeViewOptions & { readonly dragMimeTypes?: string[]; readonly dropMimeTypes?: string[]; };

function parseTreeViewOptions(value: JsonValue | undefined): TreePresentationOptions {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new TypeError('Invalid tree options'); }
	const options = value as { readonly [key: string]: JsonValue; };
	if (Object.keys(options).some(key => !['title', 'description', 'message', 'badge', 'canSelectMany', 'showCollapseAllAction', 'dragMimeTypes', 'dropMimeTypes'].includes(key))) { throw new TypeError('Unknown tree option'); }
	for (const key of ['dragMimeTypes', 'dropMimeTypes']) {
		const types = options[key];
		if (types !== undefined && (!Array.isArray(types) || types.length > 32 || types.some(mime => typeof mime !== 'string' || !/^[a-z0-9.+*-]+\/[a-z0-9.+*-]{1,128}$/.test(mime)))) { throw new TypeError('Invalid tree MIME types'); }
	}
	for (const key of ['title', 'description', 'message']) {
		if (options[key] !== undefined && (typeof options[key] !== 'string' || (options[key] as string).length > 4096)) { throw new TypeError(`Invalid tree ${key}`); }
	}
	if (typeof options.title === 'string' && (!options.title.trim() || options.title.length > 512)) { throw new TypeError('Invalid tree title'); }
	for (const key of ['canSelectMany', 'showCollapseAllAction']) {
		if (options[key] !== undefined && typeof options[key] !== 'boolean') { throw new TypeError(`Invalid tree ${key}`); }
	}
	if (options.badge !== undefined && options.badge !== null) {
		const badge = options.badge as { readonly [key: string]: JsonValue; };
		if (typeof badge !== 'object' || Array.isArray(badge) || Object.keys(badge).some(key => key !== 'value' && key !== 'tooltip')
			|| !Number.isSafeInteger(badge.value) || (badge.value as number) < 0 || typeof badge.tooltip !== 'string' || badge.tooltip.length > 4096) { throw new TypeError('Invalid tree badge'); }
	}
	return options as TreePresentationOptions;
}

function parseTreeTransfer(value: JsonValue): Record<string, string> {
	if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 32 || JSON.stringify(value).length > 1048576
		|| Object.entries(value).some(([mime, text]) => !/^[a-z0-9.+-]+\/[a-z0-9.+-]{1,128}$/.test(mime) || typeof text !== 'string')) { throw new TypeError('Invalid tree data transfer'); }
	return value as Record<string, string>;
}

function parseTreeItems(value: JsonValue): ITreeItem[] {
	if (!Array.isArray(value) || value.length > 10000) { throw new TypeError('Invalid tree children'); }
	const handles = new Set<string>();
	return value.map(raw => {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { throw new TypeError('Invalid tree item'); }
		if (Object.keys(raw).some(key => !['handle', 'label', 'highlights', 'description', 'tooltip', 'resourceUri', 'icon', 'iconDark', 'themeIcon', 'contextValue', 'accessibilityInformation', 'collapsibleState', 'checkboxState', 'editable', 'command'].includes(key))) { throw new TypeError('Unknown tree item field'); }
		if (typeof raw.handle !== 'string' || !raw.handle || raw.handle.length > 1024 || handles.has(raw.handle)) { throw new TypeError('Invalid or duplicate tree handle'); }
		handles.add(raw.handle);
		if (typeof raw.label !== 'string' || raw.label.length > 4096
			|| ![TreeItemCollapsibleState.None, TreeItemCollapsibleState.Collapsed, TreeItemCollapsibleState.Expanded].includes(raw.collapsibleState as number)) {
			throw new TypeError('Invalid tree label or collapse state');
		}
		for (const key of ['description', 'contextValue'] as const) { if (raw[key] !== undefined && (typeof raw[key] !== 'string' || raw[key].length > 4096)) { throw new TypeError(`Invalid tree ${key}`); } }
		const tooltip = parseTreeTooltip(raw.tooltip);
		const resourceUri = parseTreeUri(raw.resourceUri);
		const icon = parseTreeUri(raw.icon);
		const iconDark = parseTreeUri(raw.iconDark);
		const themeIcon = raw.themeIcon;
		if (themeIcon !== undefined && (!themeIcon || typeof themeIcon !== 'object' || Array.isArray(themeIcon) || Object.keys(themeIcon).some(key => key !== 'id') || typeof themeIcon.id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(themeIcon.id))) { throw new TypeError('Invalid tree icon'); }
		const highlights = raw.highlights;
		if (highlights !== undefined && (!Array.isArray(highlights) || highlights.length > 4096 || highlights.some(range => !Array.isArray(range) || range.length !== 2 || !Number.isInteger(range[0]) || !Number.isInteger(range[1]) || (range[0] as number) < 0 || (range[1] as number) <= (range[0] as number) || (range[1] as number) > (raw.label as string).length))) { throw new TypeError('Invalid tree highlights'); }
		const accessibility = raw.accessibilityInformation;
		if (accessibility !== undefined && (!accessibility || typeof accessibility !== 'object' || Array.isArray(accessibility) || Object.keys(accessibility).some(key => key !== 'label') || typeof accessibility.label !== 'string' || accessibility.label.length > 4096)) { throw new TypeError('Invalid tree accessibility information'); }
		if (raw.checkboxState !== undefined && raw.checkboxState !== 0 && raw.checkboxState !== 1 || raw.editable !== undefined && typeof raw.editable !== 'boolean') { throw new TypeError('Invalid tree checkbox or editing state'); }
		let command: ITreeItem['command'];
		if (raw.command !== undefined) {
			const input = raw.command;
			if (!input || typeof input !== 'object' || Array.isArray(input)
				|| Object.keys(input).some(key => key !== 'id' && key !== 'arguments')
				|| typeof input.id !== 'string' || !input.id || input.id.length > 256
				|| !Array.isArray(input.arguments) || input.arguments.length > 1024) {
				throw new TypeError('Invalid tree command');
			}
			command = { id: input.id, arguments: input.arguments };
		}
		return {
			handle: raw.handle, label: { label: raw.label, highlights: highlights as [number, number][] | undefined }, collapsibleState: raw.collapsibleState as TreeItemCollapsibleState,
			description: raw.description as string | undefined, tooltip, resourceUri, icon, iconDark,
			themeIcon: themeIcon as { id: string; } | undefined, contextValue: raw.contextValue as string | undefined,
			accessibilityInformation: accessibility as { label: string; } | undefined,
			checkbox: raw.checkboxState === undefined ? undefined : { isChecked: raw.checkboxState === 1 },
			editable: raw.editable === true, command,
		};
	});
}

function parseTreeUri(value: JsonValue | undefined): URI | undefined {
	if (value === undefined) { return undefined; }
	if (!isUriComponents(value) || Object.keys(value).some(key => !['scheme', 'authority', 'path', 'query', 'fragment'].includes(key))
		|| JSON.stringify(value).length > 8192 || !/^[A-Za-z][A-Za-z0-9+.-]*$/.test(value.scheme)) { throw new TypeError('Invalid tree URI'); }
	return URI.revive(value);
}

function parseTreeTooltip(value: JsonValue | undefined): ITreeItem['tooltip'] {
	if (value === undefined || typeof value === 'string' && value.length <= 4096) { return value; }
	if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new TypeError('Invalid tree tooltip'); }
	const markdown = value as { readonly [key: string]: JsonValue; };
	if (Object.keys(markdown).some(key => !['value', 'supportThemeIcons'].includes(key)) || typeof markdown.value !== 'string' || markdown.value.length > 4096
		|| markdown.supportThemeIcons !== undefined && typeof markdown.supportThemeIcons !== 'boolean') { throw new TypeError('Invalid tree tooltip'); }
	return { value: markdown.value, supportThemeIcons: markdown.supportThemeIcons as boolean | undefined };
}

import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import Severity from '../../../base/common/severity.js';
import { localize } from '../../../nls.js';
import { IExtensionHostApi, type ExtensionClientSource, type ExtensionHostFleetSnapshot, type ExtensionHostTreeDataProviderRegistration, type JsonValue } from '../../../platform/agentHost/common/extensionHostApi.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../platform/instantiation/common/descriptors.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { TreeView, TreeViewPane } from '../../browser/parts/views/treeView.js';
import { IViewDescriptorService, TreeItemCollapsibleState, ViewContainerLocation, type ITreeItem } from '../../common/views.js';

interface TreeBinding extends DisposableStore {
	readonly identity: string;
	readonly source: ExtensionClientSource;
	readonly tree: TreeView;
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
	) { super(); }

	public update(snapshot: ExtensionHostFleetSnapshot): void {
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
				this.bindings.set(key, this.createBinding(registration, source, active.get(key)!));
			}
		}
	}

	private createBinding(registration: ExtensionHostTreeDataProviderRegistration, source: ExtensionClientSource, identity: string): TreeBinding {
		const container = registration.containerId
			? this.descriptors.getViewContainerById(registration.containerId)
			: this.descriptors.getDefaultViewContainer(ViewContainerLocation.Sidebar);
		if (!container) { throw new Error(`No container for tree view: ${registration.viewId}`); }
		const tree = this.instantiation.createInstance(TreeView, registration.viewId, registration.title);
		const binding = Object.assign(new DisposableStore(), { identity, source, tree });
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
		binding.add(tree.onDidChangeSelectionAndFocus(event => {
			if (event.focus) { void invoke({ method: 'selection', handle: event.focus.handle }).catch(error => { if (!lifetime.signal.aborted) { this.notifications.error(error); } }); }
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
		if (Object.keys(input).some(key => key !== 'method' && key !== 'registrationId') || typeof input.registrationId !== 'string') { throw new TypeError('Invalid tree change notification'); }
		const binding = this.bindings.get(`${source.extensionId}\0${input.registrationId}`);
		if (!binding || binding.source.activationGeneration !== source.activationGeneration || binding.source.incarnation !== source.incarnation) { throw new Error('Tree provider has retired'); }
		void binding.tree.refresh();
		return true;
	}

	public clear(): void { this.bindings.clearAndDisposeAll(); }
}

function parseTreeItems(value: JsonValue): ITreeItem[] {
	if (!Array.isArray(value) || value.length > 10000) { throw new TypeError('Invalid tree children'); }
	const handles = new Set<string>();
	return value.map(raw => {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { throw new TypeError('Invalid tree item'); }
		if (Object.keys(raw).some(key => !['handle', 'label', 'description', 'tooltip', 'collapsibleState', 'checkboxState', 'editable', 'command'].includes(key))) { throw new TypeError('Unknown tree item field'); }
		if (typeof raw.handle !== 'string' || !raw.handle || raw.handle.length > 1024 || handles.has(raw.handle)) { throw new TypeError('Invalid or duplicate tree handle'); }
		handles.add(raw.handle);
		if (typeof raw.label !== 'string' || raw.label.length > 4096
			|| ![TreeItemCollapsibleState.None, TreeItemCollapsibleState.Collapsed, TreeItemCollapsibleState.Expanded].includes(raw.collapsibleState as number)) {
			throw new TypeError('Invalid tree label or collapse state');
		}
		for (const key of ['description', 'tooltip'] as const) { if (raw[key] !== undefined && (typeof raw[key] !== 'string' || raw[key].length > 4096)) { throw new TypeError(`Invalid tree ${key}`); } }
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
			handle: raw.handle, label: { label: raw.label }, collapsibleState: raw.collapsibleState as TreeItemCollapsibleState,
			description: raw.description as string | undefined, tooltip: raw.tooltip as string | undefined,
			checkbox: raw.checkboxState === undefined ? undefined : { isChecked: raw.checkboxState === 1 },
			editable: raw.editable === true, command,
		};
	});
}

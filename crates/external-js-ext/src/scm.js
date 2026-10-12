/** Public Ash SCM provider bridge. Callback objects never leave the extension realm. */
export function createSCMApi(runtime, request, invoke, retain, stateRequest = request) {
	const providers = new Map();
	const registrationId = 'ash.scm';
	let registration;
	let revision = 1;
	let selectionRevision = 0;
	let active = false;
	let disposed = false;
	let pending;
	const serial = value => JSON.parse(JSON.stringify(value, function (key, entry) {
		const original = this[key];
		if (original instanceof Uint8Array) return Array.from(original);
		if (original?.scheme && typeof original.toString === 'function') return original.toString();
		return entry;
	}));
	const action = value => ({ id: value.id, label: value.label, tooltip: value.tooltip ?? value.label, icon: value.icon?.id, enabled: value.enabled, checked: value.checked });
	function snapshot() {
		return [...providers.values()].map(entry => {
			const value = entry.provider;
			entry.actions.clear();
			entry.resources.clear();
			const actions = values => values.map(value => { entry.actions.set(value.id, value); return action(value); });
			return serial({
				id: value.id, providerId: value.providerId, label: value.label, rootUri: value.rootUri?.toString(), selected: entry.selected, selectionRevision: entry.selectionRevision,
				groups: value.groups.map(group => ({
					id: group.id, label: group.label, actions: actions(group.actions), resources: group.resources.map(resource => {
						const id = `${group.id}:${resource.path}`;
						entry.resources.set(id, resource);
						return { id, sourceUri: resource.sourceUri.toString(), path: resource.path, originalPath: resource.originalPath, decorations: resource.decorations, openLabel: resource.openLabel, actions: actions(resource.actions) };
					})
				})),
				input: { value: value.input.value, placeholder: value.input.placeholder, enabled: value.input.enabled, canAccept: value.input.canAccept, buttonLabel: value.input.buttonLabel, buttonTooltip: value.input.buttonTooltip },
				activeRepositoryName: value.activeRepositoryName, statusMessage: value.statusMessage, isBusy: value.isBusy,
				statusBarCommands: value.statusBarCommands.map(command => ({ id: command.id, text: command.text, ariaLabel: command.ariaLabel, tooltip: command.tooltip, priority: command.priority, compactGroup: command.compactGroup, icon: command.icon?.id })),
				hasHistory: !!value.historyProvider, historyRef: value.historyProvider?.historyItemRef.get(), historyRevision: entry.historyRevision,
				historyRemoteRef: value.historyProvider?.historyItemRemoteRef?.get(),
				historyBaseRef: value.historyProvider?.historyItemBaseRef?.get(),
				hasHistoryItemRefs: typeof value.historyProvider?.provideHistoryItemRefs === 'function',
				hasHistoryMergeBase: typeof value.historyProvider?.resolveHistoryItemRefsCommonAncestor === 'function',
				historyRefsRevision: entry.historyRefsRevision, historyRefsItems: entry.historyRefsItems,
				hasMerge: !!value.mergeProvider, multiDiff: entry.multiDiff?.metadata ?? null, inputRevision: entry.inputRevision,
			});
		});
	}
	function publish() {
		++revision;
		if (!active || disposed || pending) return;
		pending = Promise.resolve().then(async () => {
			const current = revision;
			await stateRequest({ operation: 'scmUpdate', registrationId, revision: current, providers: snapshot() }, 'done');
			return current;
		}).then(current => { pending = undefined; if (current !== revision) publish(); }, error => { pending = undefined; if (!disposed) console.error('SCM update failed', error); });
		// A queued replacement must send before the originating callback retires.
		retain(pending);
	}
	function ensureRegistration() {
		if (registration) return;
		registration = runtime.registerContribution({ kind: 'sourceControl', registrationId, get revision() { return revision; }, get providers() { return snapshot(); } }, 'scm', (_context, payload) => invoke(async () => {
			if (payload.method === 'initialize') { active = true; publish(); return null; }
			const entry = providers.get(payload.providerId);
			if (!entry) throw new Error('SCM provider was removed');
			const provider = entry.provider;
			if (payload.value !== undefined) {
				const inputRevision = payload.inputRevision ?? entry.inputRevision;
				if (typeof payload.value !== 'string' || payload.value.length > 32768 || !Number.isSafeInteger(inputRevision) || inputRevision < 0) throw new TypeError('Invalid SCM input revision');
				if (inputRevision >= entry.inputRevision) { provider.input.value = payload.value; entry.inputRevision = inputRevision; }
			}
			switch (payload.method) {
				case 'setInput': publish(); return null;
				case 'multiDiff': return serial(await entry.multiDiff.resolve(entry.parseUri(payload.resource)));
				case 'acceptInput': { const result = await provider.input.accept(); publish(); return { result: result ?? null, value: provider.input.value }; }
				case 'refresh': await provider.refresh(); break;
				case 'activate': await provider.activate(); break;
				case 'action': { const action = entry.actions.get(payload.actionId); if (!action?.enabled) throw new Error('SCM action is no longer available'); await action.run(); break; }
				case 'open': { const resource = entry.resources.get(payload.resourceId); if (!resource) throw new Error('SCM resource was removed'); await resource.open(payload.options, payload.sideBySide); break; }
				case 'statusBar': { const command = provider.statusBarCommands.find(command => command.id === payload.commandId); if (!command) throw new Error('SCM status command was removed'); await command.run(); break; }
				case 'decoration': return serial(await entry.decorations?.provideDecorations(entry.parseUri(payload.resource), sdkToken(_context.cancellationToken)) ?? null);
				case 'quickDiff': { const controller = new AbortController(); const listener = _context.cancellationToken.onCancellationRequested(() => controller.abort()); if (_context.cancellationToken.isCancellationRequested) controller.abort(); try { return serial(await entry.quickDiff?.provideOriginalResource(entry.parseUri(payload.resource), controller.signal) ?? null); } finally { listener.dispose(); } }
				case 'history': {
					const allowed = ['refresh', 'provideHistoryItemRefs', 'resolveHistoryItemRefsCommonAncestor', 'provideHistoryItems', 'resolveHistoryItemDetails', 'provideHistoryItemChanges', 'resolveHistoryItemChangeContents', 'resolveHistoryItemChatContext', 'resolveHistoryItemChangeRangeChatContext'];
					if (!provider.historyProvider || !allowed.includes(payload.methodName) || typeof provider.historyProvider[payload.methodName] !== 'function') throw new Error('SCM history method is unavailable');
					const args = payload.arguments.map(value => value === null ? undefined : value);
					if (payload.methodName === 'resolveHistoryItemChangeContents') {
						const change = args[1];
						args[1] = { ...change, uri: entry.parseUri(change.uri), originalUri: change.originalUri ? entry.parseUri(change.originalUri) : undefined, modifiedUri: change.modifiedUri ? entry.parseUri(change.modifiedUri) : undefined };
					}
					return serial(await provider.historyProvider[payload.methodName](...args) ?? null);
				}
				case 'merge': {
					if (!provider.mergeProvider || !['resolve', 'complete'].includes(payload.methodName)) throw new Error('SCM merge method is unavailable');
					return serial(await provider.mergeProvider[payload.methodName](...payload.arguments) ?? null);
				}
				default: throw new Error('Unknown SCM callback');
			}
			publish();
			return null;
		}));
	}
	const api = Object.freeze({
		initialize: ensureRegistration,
		registerSCMProvider(provider, options = {}) {
			if (disposed || !provider || typeof provider.id !== 'string' || !provider.id || providers.has(provider.id)) throw new TypeError('SCM provider needs a unique identity');
			ensureRegistration();
			const entry = { provider, selected: false, selectionRevision: 0, actions: new Map(), resources: new Map(), historyRevision: 1, historyRefsRevision: 0, historyRefsItems: [], inputRevision: 0, ...options };
			providers.set(provider.id, entry);
			const listeners = [provider.onDidChangeResources(publish)];
			if (provider.historyProvider) {
				listeners.push(provider.historyProvider.historyItemRef.onDidChange(publish));
				if (provider.historyProvider.historyItemRemoteRef) listeners.push(provider.historyProvider.historyItemRemoteRef.onDidChange(publish));
				if (provider.historyProvider.historyItemBaseRef) listeners.push(provider.historyProvider.historyItemBaseRef.onDidChange(publish));
				listeners.push(provider.historyProvider.onDidChange(() => { ++entry.historyRevision; entry.historyRefsItems = []; publish(); }));
				if (provider.historyProvider.onDidChangeHistoryItemRefs) {
					listeners.push(provider.historyProvider.onDidChangeHistoryItemRefs(items => {
						++entry.historyRefsRevision;
						entry.historyRefsItems = items;
						publish();
					}));
				}
			}
			if (options.decorations?.onDidChange) listeners.push(options.decorations.onDidChange(publish));
			publish();
			let removed = false;
			const dispose = () => { if (removed) return; removed = true; for (const listener of listeners) listener.dispose(); providers.delete(provider.id); publish(); };
			return { dispose, [Symbol.dispose]: dispose };
		},
		selectRepository(id) { ++selectionRevision; for (const entry of providers.values()) { entry.selected = entry.provider.id === id; if (entry.selected) entry.selectionRevision = selectionRevision; } publish(); },
	});
	return { api, dispose() { disposed = true; active = false; providers.clear(); registration?.dispose(); } };
}

function sdkToken(token) { return { get isCancellationRequested() { return token.isCancellationRequested; }, onCancellationRequested(listener, thisArg, disposables) { const original = token.onCancellationRequested(listener, thisArg); const dispose = () => original.dispose(); const value = { dispose, [Symbol.dispose]: dispose }; disposables?.push(value); return value; } }; }

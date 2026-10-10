import { __runtime, apiVersion, ExtensionError, Uri } from './index.js';

export { apiVersion, ExtensionError } from './index.js';

const languageOperations = ['completion', 'definition', 'references', 'rename', 'documentSymbols', 'foldingRanges', 'documentLinks', 'hover', 'codeAction', 'diagnostics', 'selectionRanges', 'workspaceSymbols', 'documentHighlights'];
let host;
let activating = false;
let nextInvocation = 1;

export function throwIfCancelled(token) {
	if (token.isCancellationRequested) throw new ExtensionError('cancelled', 'Invocation has been cancelled');
}

/** Snapshot-only language work has no persistent document event source. */
export const noEvent = () => Object.freeze({ dispose() {} });

function snapshot(document) {
	return Object.freeze({ ...document, getText() { return document.text; } });
}

// Only language coordinates cross this adapter; extension results retain public UTF-16 positions.
function coordinates(value, toPublic) {
	if (Array.isArray(value)) return value.map(entry => coordinates(entry, toPublic));
	if (!value || typeof value !== 'object') return value;
	const names = toPublic ? { lineIndex: 'line', columnIndex: 'character', startLineIndex: 'startLine', endLineIndex: 'endLine' }
		: { line: 'lineIndex', character: 'columnIndex', startLine: 'startLineIndex', endLine: 'endLineIndex' };
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [names[key] ?? key, coordinates(entry, toPublic)]));
}

function register(descriptor, operations, callback) {
	if (!host) throw new Error('Browser extension is not activating');
	return __runtime.registerContribution(descriptor, operations, async (invocation, payload, operation) => {
		const controller = new AbortController();
		const listener = invocation.cancellationToken.onCancellationRequested(() => controller.abort());
		let active = true;
		const bridge = host;
		const request = async operation => {
			if (!active || !bridge || bridge !== host) throw new ExtensionError('cancelled', 'Invocation has retired');
			throwIfCancelled(invocation.cancellationToken);
			const result = await bridge.clientRequest(operation, controller.signal);
			if (!active) throw new ExtensionError('cancelled', 'Invocation has retired');
			throwIfCancelled(invocation.cancellationToken);
			return result;
		};
		const context = Object.freeze({
			cancellationToken: invocation.cancellationToken,
			commands: Object.freeze({ executeCommand: (command, ...arguments_) => request({ operation: 'executeCommand', command, arguments: arguments_ }) }),
			workspace: Object.freeze({
				async getWorkspaceFolders() { return await request({ operation: 'workspaceFolders' }); },
				async getTextDocuments() { return (await request({ operation: 'listDocuments' })).documents.map(snapshot); },
				async openTextDocument(uri) { return snapshot((await request({ operation: 'readDocument', uri })).document); },
				async getConfiguration(section, resource = null) { return (await request({ operation: 'readConfiguration', section, resource })).value; },
				async stat(resource) { return await request({ operation: 'stat', resource }); },
				async readDirectory(resource) { return await request({ operation: 'readDirectory', resource }); },
			}),
		});
		try {
			throwIfCancelled(context.cancellationToken);
			const result = await callback(context, payload, operation);
			throwIfCancelled(context.cancellationToken);
			return result;
		} finally {
			active = false;
			controller.abort();
			listener.dispose();
		}
	});
}

export const commands = Object.freeze({
	registerCommand(command, title, callback, options = {}) {
		if (typeof command !== 'string' || !command || typeof title !== 'string' || !title || typeof callback !== 'function') throw new TypeError('A command requires an ID, title and callback');
		return register({ kind: 'command', registrationId: command, command, title, ...(options.icon === undefined ? {} : { icon: options.icon }), ...(options.menus === undefined ? {} : { menus: options.menus }) }, 'execute', (context, payload) => {
			if (!Array.isArray(payload.arguments)) throw new TypeError('Command arguments must be an array');
			const activeEditor = payload.activeEditor ? Object.freeze({ ...payload.activeEditor, resource: Uri.from(payload.activeEditor.resource) }) : undefined;
			return callback(Object.freeze({ ...context, activeEditor }), ...payload.arguments);
		});
	},
});

export const languages = Object.freeze({
	registerLanguageProvider(registrationId, languageIds, provider, triggerCharacters = []) {
		if (typeof registrationId !== 'string' || !registrationId || !Array.isArray(languageIds) || !languageIds.length || languageIds.some(id => typeof id !== 'string' || !id) || new Set(languageIds).size !== languageIds.length) throw new TypeError('A language provider requires an ID and unique language IDs');
		if (!Array.isArray(provider?.operations) || !provider.operations.length || provider.operations.some(operation => !languageOperations.includes(operation)) || new Set(provider.operations).size !== provider.operations.length || typeof provider.provideLanguageFeatures !== 'function') throw new TypeError('Invalid language provider operations');
		if (!Array.isArray(triggerCharacters) || triggerCharacters.length > 64 || triggerCharacters.some(value => typeof value !== 'string' || [...value].length !== 1) || new Set(triggerCharacters).size !== triggerCharacters.length) throw new TypeError('Invalid completion trigger characters');
		const operations = [...provider.operations];
		const selector = [...languageIds];
		return register({ kind: 'languageProvider', registrationId, languageIds: selector, operations, completionTriggerCharacters: [...triggerCharacters] }, operations, async (context, payload, operation) => {
			const { resource, version, text, languageId, ...fields } = payload;
			if (operation !== 'workspaceSymbols' && (!selector.includes(languageId) || typeof resource !== 'string' || typeof text !== 'string' || !Number.isSafeInteger(version) || version < 1)) throw new TypeError('Invalid language document snapshot');
			const request = Object.freeze({ ...coordinates(fields, true), operation, ...(operation === 'workspaceSymbols' ? {} : { document: snapshot({ uri: resource, version, text, languageId }) }) });
			return coordinates(await provider.provideLanguageFeatures(context, request), false);
		});
	},
});

export const window = Object.freeze({
	registerCustomTextEditorProvider(viewType, provider, options) {
		if (typeof viewType !== 'string' || !viewType || typeof provider?.resolveCustomTextEditor !== 'function' || !options || typeof options.displayName !== 'string' || !['default', 'option'].includes(options.priority) || !Array.isArray(options.selectors)) throw new TypeError('A custom editor requires a view type, provider and selector options');
		return register({ kind: 'customTextEditor', registrationId: viewType, viewType, displayName: options.displayName, priority: options.priority, selectors: [...options.selectors], ...(options.languageIds === undefined ? {} : { languageIds: [...options.languageIds] }) }, 'resolveCustomTextEditor', (context, payload) => provider.resolveCustomTextEditor(context, Object.freeze({ ...payload.document })));
	},
	createWebviewResource(content, mediaType) {
		if (!host || !activating) throw new ExtensionError('operationNotSupported', 'Browser resources must be created during activation');
		const owner = host;
		const uri = owner.createWebviewResource(content, mediaType);
		let disposed = false;
		const resource = Object.freeze({ uri, dispose() { if (!disposed) { disposed = true; owner.releaseWebviewResource(uri); } } });
		owner.subscriptions.push(resource);
		return resource;
	},
});

/** The bundled author adapter joins the shared SDK lifecycle to the product's private Worker bridge. */
export function defineBrowserExtension(activate, deactivate) {
	if (typeof activate !== 'function') throw new TypeError('An extension requires an activation callback');
	return Object.freeze({
		async activate(bridge) {
			if (bridge?.apiVersion !== apiVersion || typeof bridge.extensionId !== 'string' || !bridge.extensionId) throw new ExtensionError('incompatibleApi', 'Unsupported browser extension host API');
			const context = __runtime.beginActivation(bridge.extensionId);
			host = { ...bridge, subscriptions: context.subscriptions };
			activating = true;
			try {
				await activate(Object.freeze({ ...context, language: bridge.language }));
				for (const descriptor of JSON.parse(__runtime.sealActivation())) {
					bridge.register(descriptor, async (operation, payload, signal) => {
						const requestId = nextInvocation++;
						signal.throwIfAborted();
						const cancel = () => __runtime.cancel(requestId);
						signal.addEventListener('abort', cancel, { once: true });
						try { return JSON.parse(await __runtime.invoke(descriptor.registrationId, JSON.stringify(payload), requestId, operation)); }
						finally { signal.removeEventListener('abort', cancel); }
					});
				}
			} catch (error) {
				try { await __runtime.dispose(); } finally { host = undefined; }
				throw error;
			} finally {
				activating = false;
			}
		},
		async deactivate() {
			try { await __runtime.deactivate(deactivate); } finally { host = undefined; }
		},
	});
}

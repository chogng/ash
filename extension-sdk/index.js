// This module is embedded in the product host. It contains no transport or product permissions.
export const apiVersion = 1;
export class ExtensionError extends Error {
	constructor(code, message) { super(message); this.name = 'ExtensionError'; this.code = code; }
}
const registrations = new Map();
let phase = 'new';
let activation;

function register(registration) {
	if (phase !== 'activating') { throw new Error('Registrations must be created during activation'); }
	if (registrations.has(registration.registrationId)) { throw new Error(`Duplicate registration '${registration.registrationId}'`); }
	registrations.set(registration.registrationId, registration);
	return Object.freeze({
		dispose() {
			if (registrations.get(registration.registrationId) === registration) { registrations.delete(registration.registrationId); registration.disposeResources?.(); }
		}
	});
}

export const commands = Object.freeze({
	registerCommand(command, title, callback) {
		if (typeof command !== 'string' || !command || typeof title !== 'string' || !title || typeof callback !== 'function') {
			throw new TypeError('A command requires an ID, title and callback');
		}
		return register({ registrationId: command, kind: 'command', command, title, callback, operation: 'execute' });
	},
});

export const window = Object.freeze({
	registerStatusBar(registrationId, snapshot) {
		if (typeof snapshot !== 'function') throw new TypeError('Status bar requires a snapshot callback');
		// Compute activation metadata on demand so the registration never retains old command arguments.
		return register({ registrationId, kind: 'statusBar', get revision() { return snapshot().revision; }, get entries() { return snapshot().entries; } });
	},
});

export const languages = Object.freeze({
	registerCompletionProvider(registrationId, languageIds, provider, triggerCharacters = []) {
		if (typeof registrationId !== 'string' || !registrationId || !Array.isArray(languageIds) || !languageIds.length || languageIds.some(id => typeof id !== 'string' || !id) || new Set(languageIds).size !== languageIds.length || typeof provider?.provideCompletionItems !== 'function') {
			throw new TypeError('A completion provider requires an ID, unique language IDs and provideCompletionItems');
		}
		if (!Array.isArray(triggerCharacters) || triggerCharacters.length > 64 || triggerCharacters.some(value => typeof value !== 'string' || [...value].length !== 1) || new Set(triggerCharacters).size !== triggerCharacters.length) throw new TypeError('Invalid completion trigger characters');
		const selector = Object.freeze([...languageIds]);
		return register({
			registrationId, kind: 'languageProvider', languageIds: selector, operations: ['completion'], completionTriggerCharacters: [...triggerCharacters], operation: 'completion', async callback(context, payload) {
				if (!selector.includes(payload.languageId) || !Number.isSafeInteger(payload.version) || payload.version < 1 || typeof payload.text !== 'string') throw new TypeError('Invalid completion document snapshot');
				const position = checkedPosition({ line: payload.position?.lineIndex, character: payload.position?.columnIndex }, payload.text);
				const document = Object.freeze({ uri: payload.resource, languageId: payload.languageId, version: payload.version, text: payload.text, getText() { return payload.text; } });
				const result = await provider.provideCompletionItems(context, document, position, payload.context);
				if (!result || !Array.isArray(result.items) || result.items.length > 10_000 || typeof result.isIncomplete !== 'boolean') throw new TypeError('Invalid completion result');
				return {
					isIncomplete: result.isIncomplete, items: result.items.map(item => ({
						...item, range: checkedRange(item.range, payload.text),
						...(item.additionalTextEdits === undefined ? {} : { additionalTextEdits: item.additionalTextEdits.map(edit => ({ ...edit, range: checkedRange(edit.range, payload.text) })) }),
					}))
				};
			}
		});
	},
	registerHoverProvider(registrationId, languageIds, provider) {
		if (typeof registrationId !== 'string' || !registrationId || !Array.isArray(languageIds) || !languageIds.length || languageIds.some(id => typeof id !== 'string' || !id) || new Set(languageIds).size !== languageIds.length || typeof provider?.provideHover !== 'function') {
			throw new TypeError('A hover provider requires an ID, unique language IDs and provideHover');
		}
		const selector = Object.freeze([...languageIds]);
		return register({
			registrationId, kind: 'languageProvider', languageIds: selector, operations: ['hover'], operation: 'hover', async callback(context, payload) {
				if (!selector.includes(payload.languageId) || !Number.isSafeInteger(payload.version) || payload.version < 1 || typeof payload.text !== 'string' || (payload.resource !== undefined && typeof payload.resource !== 'string')) {
					throw new TypeError('Invalid hover document snapshot');
				}
				const position = checkedPosition({ line: payload.position?.lineIndex, character: payload.position?.columnIndex }, payload.text);
				const document = Object.freeze({ uri: payload.resource, languageId: payload.languageId, version: payload.version, text: payload.text, getText() { return payload.text; } });
				const hover = await provider.provideHover(context, document, position);
				if (hover === undefined) { return null; }
				if (!Array.isArray(hover?.contents) || !hover.contents.length || hover.contents.some(content => typeof content !== 'string' && (typeof content?.value !== 'string' || (content.language !== undefined && typeof content.language !== 'string')))) {
					throw new TypeError('Invalid hover contents');
				}
				let range;
				if (hover.range !== undefined) {
					const start = checkedPosition(hover.range.start, payload.text);
					const end = checkedPosition(hover.range.end, payload.text);
					if (start.line > end.line || (start.line === end.line && start.character > end.character)) { throw new RangeError('Hover range must be ordered'); }
					range = { start: { lineIndex: start.line, columnIndex: start.character }, end: { lineIndex: end.line, columnIndex: end.character } };
				}
				return { contents: hover.contents, ...(range === undefined ? {} : { range }) };
			}
		});
	},
});

export class ResolvedAuthority {
	constructor(host, port, connectionToken) {
		if (typeof host !== 'string' || !/^[a-zA-Z0-9._:-]{1,255}$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Invalid remote endpoint');
		checkedToken(connectionToken);
		this.host = host;
		this.port = port;
		this.connectionToken = connectionToken;
	}
}

export class Uri {
	constructor(components, external) {
		for (const key of ['scheme', 'authority', 'path', 'query', 'fragment']) {
			const value = components[key] ?? '';
			if (typeof value !== 'string' || value.length > 16384 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('Invalid URI component');
			this[key] = value;
		}
		if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(this.scheme) || /[@/?#]/.test(this.authority) || (this.authority && this.path && !this.path.startsWith('/'))) throw new TypeError('Invalid resource URI');
		if (external !== undefined) {
			const encoded = /^([^:]+):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(external);
			if (!encoded || encoded[1] !== this.scheme || (encoded[2] ?? '') !== this.authority || decodeURIComponent(encoded[3]) !== this.path || decodeURIComponent(encoded[4] ?? '') !== this.query || decodeURIComponent(encoded[5] ?? '') !== this.fragment) throw new TypeError('Inconsistent resource URI components');
		}
		this.external = external ?? `${this.scheme}:${this.authority || this.scheme === 'file' ? `//${this.authority}` : ''}${encodeURI(this.path).replaceAll('?', '%3F').replaceAll('#', '%23')}${this.query ? `?${encodeURI(this.query).replaceAll('#', '%23')}` : ''}${this.fragment ? `#${encodeURI(this.fragment)}` : ''}`;
		Object.freeze(this);
	}
	static from(components) { return new Uri(components); }
	with(change) {
		const components = { ...this };
		for (const key of ['scheme', 'authority', 'path', 'query', 'fragment']) {
			if (change[key] !== undefined) components[key] = change[key] ?? '';
		}
		// Retain escaped separators in unchanged components instead of re-encoding decoded values.
		const encoded = /^([^:]+):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(this.external);
		const next = Uri.from(components);
		const path = change.path === undefined ? encoded[3] : encodeURI(next.path).replaceAll('?', '%3F').replaceAll('#', '%23');
		const query = change.query === undefined ? encoded[4] ?? '' : encodeURI(next.query).replaceAll('#', '%23');
		const fragment = change.fragment === undefined ? encoded[5] ?? '' : encodeURI(next.fragment);
		return new Uri(components, `${next.scheme}:${next.authority || next.scheme === 'file' ? `//${next.authority}` : ''}${path}${query ? `?${query}` : ''}${fragment ? `#${fragment}` : ''}`);
	}
	toString() { return this.external; }
	toJSON() { return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment, external: this.external }; }
}

function checkedResolvedOptions(result) {
	const options = {};
	if (result.isTrusted !== undefined) {
		if (typeof result.isTrusted !== 'boolean') throw new TypeError('Invalid resolver trust option');
		options.isTrusted = result.isTrusted;
	}
	if (result.extensionHostEnv !== undefined) {
		const env = result.extensionHostEnv;
		if (!env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length > 128) throw new TypeError('Invalid resolver environment');
		for (const [key, value] of Object.entries(env)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || (value !== null && (typeof value !== 'string' || value.length > 8192 || value.includes('\0')))) throw new TypeError('Invalid resolver environment entry');
		}
		options.extensionHostEnv = { ...env };
	}
	const session = result.authenticationSessionForInitializingExtensions;
	if (session !== undefined) {
		if (!session || [session.id, session.providerId].some(value => typeof value !== 'string' || !value || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value))) throw new TypeError('Invalid resolver authentication session');
		// The local authentication owner retains the token; consumers receive only a session reference.
		options.authenticationSession = { id: session.id, providerId: session.providerId };
	}
	return Object.keys(options).length ? { options } : {};
}

export class ManagedResolvedAuthority {
	constructor(makeConnection, connectionToken) {
		if (typeof makeConnection !== 'function') throw new TypeError('Managed authority requires a connection factory');
		checkedToken(connectionToken);
		this.makeConnection = makeConnection;
		this.connectionToken = connectionToken;
	}
}

export class RemoteAuthorityResolverError extends Error {
	constructor(message, code = 'Unknown', handled = false) {
		super(message);
		this.name = 'RemoteAuthorityResolverError';
		this.code = code;
		this.handled = handled;
	}
	static NotAvailable(message, handled = false) { return new RemoteAuthorityResolverError(message, 'NotAvailable', handled); }
	static TemporarilyNotAvailable(message) { return new RemoteAuthorityResolverError(message, 'TemporarilyNotAvailable'); }
}

function checkedToken(token) {
	if (token !== undefined && (typeof token !== 'string' || token.length > 8192 || /[\u0000-\u001f\u007f]/.test(token))) throw new TypeError('Invalid remote connection token');
}

// Hex chunks avoid a JSON node per byte and stay within the invocation payload quota.
function bytesFromHex(hex) {
	if (typeof hex !== 'string' || hex.length > 65536 || hex.length % 2 || !/^[0-9a-f]*$/.test(hex)) throw new TypeError('Invalid managed socket bytes');
	return Uint8Array.from({ length: hex.length / 2 }, (_, index) => parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

export const workspace = Object.freeze({
	registerRemoteAuthorityResolver(authorityPrefix, resolver) {
		if (typeof authorityPrefix !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(authorityPrefix) || typeof resolver?.resolve !== 'function') throw new TypeError('Invalid Remote resolver');
		if (resolver.getCanonicalURI !== undefined && typeof resolver.getCanonicalURI !== 'function') throw new TypeError('Invalid canonical URI provider');
		let nextId = 0;
		const factories = new Map();
		const sockets = new Map();
		function release(id) {
			const state = sockets.get(id);
			if (!state) return;
			sockets.delete(id);
			for (const listener of state.listeners) listener.dispose();
			state.connection.end();
		}
		return register({
			registrationId: `remote-authority:${authorityPrefix}`, kind: 'remoteAuthorityResolver', authorityPrefix,
			disposeResources() {
				factories.clear();
				for (const id of [...sockets.keys()]) release(id);
			},
			async dispatch(payload, operation) {
				const owner = payload?.__connectionOwner;
				if (typeof owner !== 'string' || !/^[0-9]{1,20}$/.test(owner)) throw new TypeError('Invalid managed connection owner');
				if (operation === 'remoteReleaseOwner') {
					for (const [id, factory] of factories) { if (factory.owner === owner) factories.delete(id); }
					for (const [id, state] of sockets) { if (state.owner === owner) release(id); }
					return null;
				}
				if (operation === 'getCanonicalURI') {
					if (typeof payload.authority !== 'string' || !payload.authority.startsWith(`${authorityPrefix}+`) || payload.authority.length > 2048 || payload.uri?.scheme !== 'ash-remote' || payload.uri?.authority !== payload.authority || typeof payload.uri?.external !== 'string' || payload.uri.external.length > 16384) throw new TypeError('Invalid canonical URI request');
					const uri = new Uri(payload.uri, payload.uri.external);
					const result = await resolver.getCanonicalURI?.(uri);
					if (result == null) return null;
					if (!(result instanceof Uri)) throw new TypeError('Canonical URI provider must return a Uri');
					return result.toJSON();
				}
				if (operation === 'resolveAuthority') {
					if (typeof payload?.authority !== 'string' || payload.authority.length > 2048 || !payload.authority.startsWith(`${authorityPrefix}+`) || !Number.isSafeInteger(payload.resolveAttempt) || payload.resolveAttempt < 1) throw new TypeError('Invalid Remote resolution request');
					try {
						const result = await resolver.resolve(payload.authority, Object.freeze({ resolveAttempt: payload.resolveAttempt }));
						checkedToken(result?.connectionToken);
						const options = checkedResolvedOptions(result);
						// Re-resolution retires the previous factory and all sockets from that result.
						for (const [id, factory] of factories) { if (factory.owner === owner) factories.delete(id); }
						for (const [id, state] of sockets) { if (state.owner === owner) release(id); }
						if (result instanceof ManagedResolvedAuthority) {
							const id = ++nextId;
							if (factories.size >= 128) throw new Error('Managed factory quota exceeded');
							factories.set(id, { owner, makeConnection: result.makeConnection });
							return { type: 'managed', id, connectionToken: result.connectionToken ?? null, ...options };
						}
						if (!(result instanceof ResolvedAuthority)) throw new TypeError('Resolver must return a ResolvedAuthority');
						return { type: 'webSocket', host: result.host, port: result.port, connectionToken: result.connectionToken ?? null, ...options };
					} catch (error) {
						if (!(error instanceof RemoteAuthorityResolverError)) throw error;
						return { error: { code: error.code, message: error.message, handled: error.handled } };
					}
				}
				if (operation === 'remoteConnect') {
					const factory = factories.get(payload.id);
					if (!factory || factory.owner !== owner || sockets.size >= 128 || [...sockets.values()].filter(state => state.owner === owner).length >= 4) throw new Error('Managed connection factory is unavailable');
					const connection = await factory.makeConnection();
					if (factories.get(payload.id) !== factory || phase !== 'active') { connection.end(); throw new Error('Managed connection factory was retired'); }
					if (typeof connection?.send !== 'function' || typeof connection.end !== 'function' || typeof connection.onDidReceiveMessage !== 'function' || typeof connection.onDidClose !== 'function' || typeof connection.onDidEnd !== 'function') throw new TypeError('Invalid ManagedMessagePassing');
					const id = ++nextId;
					const state = { owner, connection, queue: [], bytes: 0, closed: false, ended: false, error: null, listeners: [] };
					sockets.set(id, state);
					state.listeners.push(connection.onDidReceiveMessage(data => {
						if (state.closed || state.ended) return;
						if (!(data instanceof Uint8Array) || state.bytes + data.byteLength > 1024 * 1024 || state.queue.length + Math.ceil(data.byteLength / 32768) > 64) {
							state.closed = true; state.error = 'Managed receive quota exceeded'; connection.end(); return;
						}
						for (let offset = 0; offset < data.byteLength; offset += 32768) {
							const chunk = data.slice(offset, offset + 32768);
							state.queue.push(Array.from(chunk, byte => byte.toString(16).padStart(2, '0')).join(''));
							state.bytes += chunk.byteLength;
						}
					}));
					state.listeners.push(connection.onDidClose(error => { state.closed = true; state.error = error?.message?.slice(0, 4096) ?? null; }));
					state.listeners.push(connection.onDidEnd(() => { state.ended = true; }));
					return { id };
				}
				if (operation === 'remoteRelease') { if (sockets.get(payload.id)?.owner === owner) release(payload.id); return null; }
				const state = sockets.get(payload.id);
				if (!state || state.owner !== owner) throw new Error('Managed socket was retired');
				if (operation === 'remoteRead') {
					const data = state.queue.shift() ?? '';
					state.bytes -= data.length / 2;
					return { data, closed: state.closed && state.queue.length === 0, ended: state.ended && state.queue.length === 0, error: state.error };
				}
				if (operation === 'remoteWrite') { state.connection.send(bytesFromHex(payload.data)); return null; }
				if (operation === 'remoteDrain') { await state.connection.drain?.(); return null; }
				if (operation === 'remoteEnd') { state.connection.end(); return null; }
				throw new TypeError('Invalid Remote operation');
			}
		});
	},
	registerRemoteConnectionResolver(authorityPrefix, resolver) {
		// Reserved prefixes are admitted by the host's package authority, not extension-owned state.
		if (typeof authorityPrefix !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(authorityPrefix) || typeof resolver?.resolve !== 'function') throw new TypeError('Invalid Remote resolver');
		return register({
			registrationId: `remote:${authorityPrefix}`, kind: 'remoteConnectionResolver', authorityPrefix, operation: 'resolveConnection', async callback(context, payload) {
				if (typeof payload?.authority !== 'string' || !payload.authority.startsWith(`${authorityPrefix}+`)) throw new TypeError('Invalid Remote authority');
				const result = await resolver.resolve(context, payload.authority);
				if (!result || Object.keys(result).join(',') !== 'connectionName' || typeof result.connectionName !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(result.connectionName)) throw new TypeError('Invalid saved Remote connection reference');
				return result;
			}
		});
	},
	registerTextDocumentEvents(registrationId, listener) {
		if (typeof registrationId !== 'string' || !registrationId || typeof listener !== 'function') throw new TypeError('Document events require an ID and listener');
		return register({ registrationId, kind: 'textDocumentEvents', operation: 'documentEvent', callback: listener });
	},
});

function checkedPosition(position, text) {
	if (!Number.isSafeInteger(position?.line) || position.line < 0 || !Number.isSafeInteger(position?.character) || position.character < 0) { throw new TypeError('Invalid UTF-16 position'); }
	const line = text.split('\n')[position.line];
	if (line === undefined || position.character > line.replace(/\r$/, '').length) { throw new RangeError('Position is outside the document'); }
	return Object.freeze({ line: position.line, character: position.character });
}

function checkedRange(range, text) {
	const start = checkedPosition(range?.start, text);
	const end = checkedPosition(range?.end, text);
	if (start.line > end.line || start.line === end.line && start.character > end.character) throw new RangeError('Range must be ordered');
	return { start: { lineIndex: start.line, columnIndex: start.character }, end: { lineIndex: end.line, columnIndex: end.character } };
}

function commandContext(requestId) {
	async function request(operation, resultKind) {
		let result;
		try { result = JSON.parse(await globalThis.__ashRequest(requestId, JSON.stringify(operation))); }
		catch (error) {
			if (typeof error?.code === 'string') { throw new ExtensionError(error.code, error.message); }
			throw error;
		}
		if (result.result !== resultKind) { throw new Error(`Invalid result for '${operation.operation}'`); }
		return result;
	}
	async function showMessage(message, severity) {
		await request({ operation: 'showMessage', message, severity }, 'done');
	}
	return Object.freeze({
		languages: Object.freeze({
			async setDiagnostics(collection, entries) {
				await request({ operation: 'setDiagnostics', collection, entries }, 'done');
			},
		}),
		workspace: Object.freeze({
			async openRemoteConnection(authority) {
				await request({ operation: 'openRemoteConnection', authority }, 'done');
			},
			async openTextDocument(uri) {
				const { document } = await request({ operation: 'readDocument', uri }, 'document');
				return Object.freeze({ ...document, getText() { return document.text; } });
			},
			async readTextFile(path) {
				return (await request({ operation: 'readWorkspaceFile', path }, 'file')).text;
			},
		}),
		window: Object.freeze({
			async setStatusBarEntries(registrationId, revision, entries) {
				await request({ operation: 'setStatusBarEntries', registrationId, revision, entries }, 'done');
			},
			showInformationMessage: message => showMessage(message, 'information'),
			showWarningMessage: message => showMessage(message, 'warning'),
			showErrorMessage: message => showMessage(message, 'error'),
			async showQuickPick(items, placeholder) {
				const { index } = await request({ operation: 'showQuickPick', items: [...items], placeholder }, 'selection');
				if (index === null) { return undefined; }
				if (!Number.isSafeInteger(index) || index < 0 || index >= items.length) { throw new Error('Invalid Quick Pick selection'); }
				return items[index];
			},
		}),
	});
}

// Only the host uses this export. Authority remains in Rust even if an extension calls it directly.
export const __runtime = Object.freeze({
	get isDisposed() { return phase === 'disposed'; },
	beginActivation(extensionId) {
		if (phase !== 'new') { throw new Error('Extension is already initialized'); }
		phase = 'activating';
		activation = Object.freeze({ extensionId, subscriptions: [] });
		return activation;
	},
	sealActivation() {
		if (phase !== 'activating') { throw new Error('Extension is not activating'); }
		phase = 'active';
		return JSON.stringify([...registrations.values()].map(({ callback, operation, dispatch, disposeResources, ...descriptor }) => descriptor));
	},
	async invoke(registrationId, payloadJson, requestId, operation) {
		if (phase !== 'active') { throw new Error('Extension is not active'); }
		const registration = registrations.get(registrationId);
		if (!registration) { throw new Error(`Registration '${registrationId}' is disposed`); }
		if (!registration.dispatch && registration.operation !== operation) { throw new TypeError('Invocation operation does not match its registration'); }
		const payload = JSON.parse(payloadJson);
		let result;
		if (registration.dispatch) {
			result = await registration.dispatch(payload, operation);
		} else if (operation === 'execute') {
			if (!Array.isArray(payload.arguments)) { throw new TypeError('Command arguments must be an array'); }
			result = await registration.callback(commandContext(requestId), ...payload.arguments);
		} else {
			result = await registration.callback(commandContext(requestId), payload);
		}
		const encoded = JSON.stringify(result === undefined ? null : result);
		if (encoded === undefined) { throw new TypeError('Command result must be a JSON value'); }
		return encoded;
	},
	async deactivate(callback) {
		try { if (typeof callback === 'function') { await callback(); } }
		finally { this.dispose(); }
	},
	dispose() {
		phase = 'disposed';
		let failure;
		for (const registration of registrations.values()) {
			try { registration.disposeResources?.(); } catch (error) { failure ??= error; }
		}
		registrations.clear();
		for (const subscription of activation?.subscriptions.splice(0).reverse() ?? []) {
			try { subscription.dispose(); } catch (error) { failure ??= error; }
		}
		activation = undefined;
		if (failure) { throw failure; }
	},
});

// Private Host RPC callback and activation owner. Extensions obtain only the standard vscode API.
export const apiVersion = 1;
export class ExtensionError extends Error {
	constructor(code, message) { super(message); this.name = 'ExtensionError'; this.code = code; }
}
const registrations = new Map();
const invocations = new Map();
let phase = 'new';
let activation;
let registrationListener;
let registrationRevision = 0;
let speechRegistrationGeneration = 0;

function publishSpeechRegistrations() {
	if (phase !== 'active') return;
	registrationListener?.(JSON.stringify({ revision: ++registrationRevision, speechProviders: [...registrations.values()].filter(value => value.kind === 'speechProvider').map(({ registrationId, kind, identifier, registrationGeneration }) => ({ registrationId, kind, identifier, registrationGeneration })) }));
}

export class CancellationTokenSource {
	#cancelled = false;
	#disposed = false;
	#listeners = new Set();
	constructor() {
		const source = this;
		this.token = Object.freeze({
			get isCancellationRequested() { return source.#cancelled; },
			onCancellationRequested(listener, thisArg, disposables) {
				if (typeof listener !== 'function') throw new TypeError('Cancellation listener must be a function');
				const entry = { listener, thisArg };
				let active = true;
				const disposable = Object.freeze({ dispose() { active = false; source.#listeners.delete(entry); } });
				if (source.#cancelled) {
					// Late listeners run asynchronously and can be disposed before delivery.
					void Promise.resolve().then(() => { if (active) listener.call(thisArg, undefined); });
				} else if (!source.#disposed) source.#listeners.add(entry);
				disposables?.push(disposable);
				return disposable;
			},
		});
	}
	cancel() {
		if (this.#cancelled || this.#disposed) return;
		this.#cancelled = true;
		const listeners = [...this.#listeners];
		this.#listeners.clear();
		let failure;
		for (const entry of listeners) { try { entry.listener.call(entry.thisArg, undefined); } catch (error) { failure ??= error; } }
		if (failure) throw failure;
	}
	dispose() { this.#disposed = true; this.#listeners.clear(); }
}

function register(registration) {
	if (phase !== 'activating' && !(phase === 'active' && registration.kind === 'speechProvider' && registrationListener)) { throw new Error('Registrations must be created during activation'); }
	if (registrations.has(registration.registrationId)) { throw new Error(`Duplicate registration '${registration.registrationId}'`); }
	registrations.set(registration.registrationId, registration);
	if (registration.kind === 'speechProvider') publishSpeechRegistrations();
	return Object.freeze({
		dispose() {
			if (registrations.get(registration.registrationId) === registration) {
				registrations.delete(registration.registrationId);
				try { registration.disposeResources?.(); }
				finally { if (registration.kind === 'speechProvider') publishSpeechRegistrations(); }
			}
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


function checkedToken(token) {
	if (token !== undefined && (typeof token !== 'string' || token.length > 8192 || /[\u0000-\u001f\u007f]/.test(token))) throw new TypeError('Invalid remote connection token');
}

// Hex chunks avoid a JSON node per byte and stay within the invocation payload quota.
function bytesFromHex(hex) {
	if (typeof hex !== 'string' || hex.length > 65536 || hex.length % 2 || !/^[0-9a-f]*$/.test(hex)) throw new TypeError('Invalid managed socket bytes');
	return Uint8Array.from({ length: hex.length / 2 }, (_, index) => parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

export const workspace = Object.freeze({
	registerWorkspaceEvents(registrationId, listener) {
		if (typeof registrationId !== 'string' || !registrationId || typeof listener !== 'function') throw new TypeError('Workspace events require an ID and listener');
		return register({ registrationId, kind: 'workspaceEvents', operation: 'workspaceEvent', callback: listener });
	},
	registerRemoteAuthorityResolver(authorityPrefix, resolver, Uri) {
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
					const uri = Uri.parse(payload.uri.external);
					if (['scheme', 'authority', 'path', 'query', 'fragment'].some(key => uri[key] !== (payload.uri[key] ?? ''))) throw new TypeError('Inconsistent canonical URI components');
					const result = await resolver.getCanonicalURI?.(uri);
					if (result == null) return null;
					if (!(result instanceof Uri)) throw new TypeError('Canonical URI provider must return a Uri');
					return { ...result.toJSON(), external: result.toString() };
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
	registerTextDocumentEvents(registrationId, listener) {
		if (typeof registrationId !== 'string' || !registrationId || typeof listener !== 'function') throw new TypeError('Document events require an ID and listener');
		return register({ registrationId, kind: 'textDocumentEvents', operation: 'documentEvent', callback: listener });
	},
});

// Providers and explicit Tasks share one bounded PTY handle owner.
function registerPseudoterminalCallbacks(registration, provider) {
	const terminals = new Map();
	let sequence = 0;
	function release(id) {
		const state = terminals.get(id);
		if (!state) return;
		terminals.delete(id);
		let failure;
		for (const listener of state.listeners) { try { listener?.dispose?.(); } catch (error) { failure ??= error; } }
		if (!state.closed) { state.closed = true; try { state.pty.close(); } catch (error) { failure ??= error; } }
		if (failure) throw failure;
	}
	async function retainPty(pty) {
		if (terminals.size >= 64) throw new Error('Pseudoterminal quota exceeded');
		if (typeof pty?.onDidWrite !== 'function' || typeof pty.open !== 'function' || typeof pty.close !== 'function') throw new TypeError('CustomExecution requires a Pseudoterminal');
		const id = `pty.${++sequence}`;
		const state = { pty, listeners: [], events: [], bytes: 0, closed: false, opened: false };
		function enqueue(event) {
			if (state.events.length >= 1024 || state.bytes + JSON.stringify(event).length > 262144) {
				state.events = [{ type: 'close', code: 1 }]; state.bytes = 0;
				if (!state.closed) { state.closed = true; pty.close(); }
				return;
			}
			state.bytes += JSON.stringify(event).length;
			state.events.push(event);
		}
		terminals.set(id, state);
		try {
			state.listeners.push(pty.onDidWrite(data => { if (!state.closed) { if (typeof data !== 'string') throw new TypeError('Pseudoterminal output must be a string'); enqueue({ type: 'data', data }); } }));
			if (pty.onDidClose) state.listeners.push(pty.onDidClose(code => {
				if (!state.closed) {
					if (code !== undefined && (!Number.isSafeInteger(code) || code < 0 || code > 2147483647)) throw new TypeError('Invalid custom task exit code');
					enqueue({ type: 'close', code: code ?? null }); state.closed = true;
				}
			}));
			if (pty.onDidChangeName) state.listeners.push(pty.onDidChangeName(name => { if (!state.closed && typeof name === 'string') enqueue({ type: 'name', name }); }));
			if (state.listeners.some(listener => typeof listener?.dispose !== 'function')) throw new TypeError('Pseudoterminal events require disposable listeners');
		} catch (error) { try { release(id); } finally { throw error; } }
		return { ptyId: id, acceptsInput: typeof pty.handleInput === 'function' };
	}

	const handle = register({
		...registration, operation: [
			...(registration.kind === 'taskEvents' ? ['taskEvent'] : registration.kind === 'terminalProfileProvider' ? ['createTerminalProfile'] : ['provideTasks', 'resolveTask']),
			'createTaskTerminal', 'openTaskTerminal', 'readTaskTerminal', 'inputTaskTerminal', 'resizeTaskTerminal', 'closeTaskTerminal',
		],
		async callback(context, payload, operation) {
			if (operation === 'taskEvent') return await provider.onTaskEvent(context, payload);
			if (operation === 'provideTasks') return { tasks: await provider.provideTasks(context) ?? [] };
			if (operation === 'resolveTask') {
				const task = await provider.resolveTask?.(context, payload.task);
				return task === undefined ? null : { task };
			}
			if (operation === 'createTerminalProfile') {
				const profile = await provider.createTerminalProfile(context);
				if (!profile) return { options: null };
				const { pty, ...options } = profile;
				if (context.cancellationToken.isCancellationRequested) { pty?.close(); return { options: null }; }
				return pty ? { options, pty: await retainPty(pty) } : { options };
			}
			if (operation === 'createTaskTerminal') {
				if (terminals.size >= 64 || typeof provider.createTaskTerminal !== 'function') throw new Error('Custom task terminal is unavailable');
				return retainPty(await provider.createTaskTerminal(context, payload.executionId, payload.definition));
			}
			const state = terminals.get(payload.ptyId);
			if (operation === 'closeTaskTerminal') { release(payload.ptyId); return null; }
			if (!state) throw new Error('Custom task terminal has been released');
			if (operation === 'openTaskTerminal' && !state.opened && !state.closed) { state.opened = true; state.pty.open(payload.dimensions ?? undefined); }
			if (operation === 'inputTaskTerminal' && !state.closed) {
				if (typeof payload.data !== 'string' || payload.data.length > 32768) throw new TypeError('Invalid task input');
				state.pty.handleInput?.(payload.data);
			}
			if (operation === 'resizeTaskTerminal' && !state.closed) {
				if (!Number.isInteger(payload.dimensions?.columns) || !Number.isInteger(payload.dimensions?.rows) || payload.dimensions.columns < 1 || payload.dimensions.rows < 1 || payload.dimensions.columns > 65535 || payload.dimensions.rows > 65535) throw new TypeError('Invalid task dimensions');
				state.pty.setDimensions?.(payload.dimensions);
			}
			const events = state.events.splice(0);
			state.bytes = 0;
			return { events };
		},
	});
	const disposable = Object.freeze({
		dispose() {
			let failure;
			for (const id of [...terminals.keys()]) { try { release(id); } catch (error) { failure ??= error; } }
			handle.dispose();
			if (failure) throw failure;
		}
	});
	activation.subscriptions.push(disposable);
	return disposable;
}

/** Provider sessions use the existing bounded invocation protocol, not a product audio transport. */
export const speech = Object.freeze({
	registerSpeechProvider(registrationId, identifier, provider) {
		if (typeof identifier !== 'string' || !identifier || identifier.length > 256 ||
			['provideSpeechToTextSession', 'provideTextToSpeechSession', 'provideKeywordRecognitionSession'].some(name => typeof provider?.[name] !== 'function')) {
			throw new TypeError('Speech registration requires an identifier and all standard session factories');
		}
		const sessions = new Map();
		function release(id) {
			const state = sessions.get(id);
			if (!state) return;
			sessions.delete(id);
			state.closed = true;
			try { state.token.cancel(); }
			finally {
				try { state.listener?.dispose(); }
				finally { state.token.dispose(); state.events.length = 0; }
			}
		}
		const registration = {
			registrationId, kind: 'speechProvider', identifier, registrationGeneration: ++speechRegistrationGeneration,
			operation: ['createSpeechSession', 'readSpeechSession', 'synthesizeSpeech', 'closeSpeechSession'],
			disposeResources() {
				let failure;
				for (const id of [...sessions.keys()]) { try { release(id); } catch (error) { failure ??= error; } }
				if (failure) throw failure;
			},
			async callback(context, payload, operation) {
				if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.sessionId !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.sessionId)) throw new TypeError('Invalid speech session identity');
				const allowed = operation === 'createSpeechSession' ? ['sessionId', 'kind', 'language'] : operation === 'synthesizeSpeech' ? ['sessionId', 'text'] : ['sessionId'];
				if (Object.keys(payload).some(key => !allowed.includes(key))) throw new TypeError('Unexpected speech session field');
				const id = payload.sessionId;
				if (operation === 'closeSpeechSession') { release(id); return {}; }
				if (operation === 'createSpeechSession') {
					if (sessions.has(id) || sessions.size >= 32) throw new Error('Speech session admission limit exceeded');
					const factories = { speechToText: 'provideSpeechToTextSession', textToSpeech: 'provideTextToSpeechSession', keywordRecognition: 'provideKeywordRecognitionSession' };
					if (!Object.hasOwn(factories, payload.kind) || payload.language !== undefined && (typeof payload.language !== 'string' || !/^[A-Za-z0-9-]{1,35}$/.test(payload.language))) throw new TypeError('Invalid speech session options');
					const state = { token: new CancellationTokenSource(), events: [], bytes: 0, closed: false, listener: undefined, kind: payload.kind, session: undefined };
					sessions.set(id, state);
					const cancellation = context.cancellationToken.onCancellationRequested(() => release(id));
					try {
						state.session = await provider[factories[payload.kind]](state.token.token, payload.language === undefined ? undefined : { language: payload.language });
						if (context.cancellationToken.isCancellationRequested || sessions.get(id) !== state) throw new Error('Speech session creation cancelled');
						if (typeof state.session?.onDidChange !== 'function' || state.kind === 'textToSpeech' && typeof state.session.synthesize !== 'function') throw new TypeError('Invalid speech provider session');
						state.listener = state.session.onDidChange(event => {
							if (state.closed || sessions.get(id) !== state) return;
							const maximum = state.kind === 'speechToText' ? 5 : state.kind === 'textToSpeech' ? 3 : 2;
							if (!Number.isInteger(event?.status) || event.status < 1 || event.status > maximum || event.text !== undefined && (typeof event.text !== 'string' || event.text.length > 16384)) {
								release(id); return;
							}
							const value = { status: event.status, ...(event.text === undefined ? {} : { text: event.text }) };
							const bytes = JSON.stringify(value).length;
							if (state.events.length >= 128 || state.bytes + bytes > 262144) { release(id); return; }
							state.events.push(value); state.bytes += bytes;
							if (state.kind === 'speechToText' && (event.status === 4 || event.status === 5) || state.kind === 'keywordRecognition' && event.status === 2) state.closed = true;
						});
						if (typeof state.listener?.dispose !== 'function') throw new TypeError('Speech event subscription must be disposable');
						if (sessions.get(id) !== state) { state.listener.dispose(); throw new Error('Speech session was released while subscribing'); }
						return {};
					} catch (error) { release(id); throw error; }
					finally { cancellation.dispose(); }
				}
				const state = sessions.get(id);
				if (!state) throw new Error('Speech session is unavailable');
				if (operation === 'readSpeechSession') {
					const events = state.events.splice(0); state.bytes = 0;
					return { events, closed: state.closed };
				}
				if (operation === 'synthesizeSpeech') {
					if (state.kind !== 'textToSpeech' || state.closed || typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 16384) throw new TypeError('Invalid speech synthesis request');
					const cancellation = context.cancellationToken.onCancellationRequested(() => release(id));
					try {
						await state.session.synthesize(payload.text);
						if (context.cancellationToken.isCancellationRequested) release(id);
						return {};
					} finally { cancellation.dispose(); }
				}
				throw new Error('Unsupported speech operation');
			},
		};
		const handle = register(registration);
		activation.subscriptions.push(handle);
		return handle;
	},
});

export const terminals = Object.freeze({
	registerTerminalLinkProvider(registrationId, provider) {
		if (typeof provider?.provideTerminalLinks !== 'function' || typeof provider?.handleTerminalLink !== 'function') throw new TypeError('Terminal links require provide and handle callbacks');
		const links = new Map();
		let sequence = 0;
		const provide = async (context, payload) => {
			if (typeof payload.line !== 'string' || payload.line.length > 32768 || !payload.terminal || typeof payload.terminal.id !== 'string' || typeof payload.terminal.name !== 'string') throw new TypeError('Invalid terminal link context');
			const result = await provider.provideTerminalLinks(context, payload);
			if (context.cancellationToken.isCancellationRequested || result === undefined || result === null) return [];
			if (!Array.isArray(result) || result.length > 256) throw new TypeError('Invalid terminal links');
			for (const link of result) {
				if (!Number.isSafeInteger(link?.startIndex) || link.startIndex < 0 || !Number.isSafeInteger(link.length) || link.length < 1 || link.startIndex + link.length > payload.line.length || link.tooltip !== undefined && (typeof link.tooltip !== 'string' || link.tooltip.length > 512 || /[\u0000-\u001f\u007f]/.test(link.tooltip))) throw new TypeError('Invalid terminal link range or tooltip');
			}
			return result;
		};
		return register({
			registrationId, kind: 'terminalLinkProvider', operation: ['provideTerminalLinks', 'handleTerminalLink'],
			disposeResources() { links.clear(); },
			async callback(context, payload, operation) {
				if (operation === 'handleTerminalLink') {
					// A picker can outlive the bounded callback cache. Re-resolve its
					// original line on acceptance rather than silently dropping the click.
					const entry = links.get(payload.id) ?? (await provide(context, payload)).find(link => link.startIndex === payload.startIndex && link.length === payload.length);
					if (entry && !context.cancellationToken.isCancellationRequested) await provider.handleTerminalLink(context, entry);
					return null;
				}
				const validated = (await provide(context, payload)).map(link => ({ link, id: String(++sequence) }));
				for (const entry of validated) links.set(entry.id, entry.link);
				// Links are callback handles, not terminal history. Bound retained extension
				// objects even when the user keeps a terminal producing output indefinitely.
				while (links.size > 2048) links.delete(links.keys().next().value);
				return { links: validated.map(({ link, id }) => ({ id, startIndex: link.startIndex, length: link.length, ...(link.tooltip === undefined ? {} : { label: link.tooltip }) })) };
			},
		});
	},
	registerEnvironmentVariableCollection(registrationId, snapshot) {
		if (typeof snapshot !== 'function') throw new TypeError('Terminal environment collection requires a snapshot callback');
		return register({ registrationId, kind: 'terminalEnvironment', operation: 'getTerminalEnvironment', callback: snapshot });
	},
	registerTerminalProfileProvider(registrationId, profileId, title, provider) {
		if (typeof provider?.createTerminalProfile !== 'function' || typeof profileId !== 'string' || !profileId || typeof title !== 'string' || !title) throw new TypeError('Terminal profile providers require an ID, title and callback');
		return registerPseudoterminalCallbacks({ registrationId, kind: 'terminalProfileProvider', profileId, title }, provider);
	},
});

export const tasks = Object.freeze({
	registerTaskEvents(registrationId, listener, createTaskTerminal) {
		if (typeof registrationId !== 'string' || !registrationId || typeof listener !== 'function') throw new TypeError('Task events require an ID and listener');
		if (createTaskTerminal !== undefined && typeof createTaskTerminal !== 'function') throw new TypeError('Custom task terminal requires a factory');
		return registerPseudoterminalCallbacks({ registrationId, kind: 'taskEvents' }, { onTaskEvent: listener, createTaskTerminal });
	},
	registerTaskProvider(registrationId, taskType, provider) {
		if (typeof provider?.provideTasks !== 'function' || typeof taskType !== 'string' || !taskType) throw new TypeError('Task providers require a type and provideTasks');
		return registerPseudoterminalCallbacks({ registrationId, kind: 'taskProvider', taskType }, provider);
	},
});

export const debug = Object.freeze({
	registerDebugEvents(registrationId, listener) {
		if (typeof listener !== 'function') throw new TypeError('Debug event observer requires a callback');
		return register({ registrationId, kind: 'debugEvents', operation: 'debugEvent', callback: listener });
	},
	registerDebugConfigurationProvider(registrationId, debuggerType, provider, triggerKind = 1) {
		const operations = ['provideDebugConfigurations', 'resolveDebugConfiguration', 'resolveDebugConfigurationWithSubstitutedVariables'];
		if (typeof debuggerType !== 'string' || !debuggerType || ![1, 2].includes(triggerKind) || !operations.some(operation => typeof provider?.[operation] === 'function') || operations.some(operation => provider?.[operation] !== undefined && typeof provider[operation] !== 'function')) throw new TypeError('Debug configuration providers require a type, trigger kind and callbacks');
		return register({
			registrationId, kind: 'debugConfigurationProvider', debuggerType, triggerKind, operation: operations,
			async callback(context, payload, operation) {
				if (operation === 'provideDebugConfigurations') return { configurations: await provider.provideDebugConfigurations?.(context, payload.folder ?? undefined) ?? [] };
				const callback = provider[operation];
				const configuration = callback ? await callback.call(provider, context, payload.folder ?? undefined, payload.configuration) : payload.configuration;
				// JSON cannot encode undefined; cancellation must survive the Host boundary.
				return configuration === undefined ? { cancelled: true } : { configuration };
			},
		});
	},
	registerDebugAdapterTrackerFactory(registrationId, debuggerType, factory) {
		if (typeof debuggerType !== 'string' || !debuggerType || typeof factory?.createDebugAdapterTracker !== 'function') { throw new TypeError('Debug Adapter trackers require a type and factory'); }
		const trackers = new Map();
		const operations = ['onWillStartSession', 'onWillReceiveMessage', 'onDidSendMessage', 'onWillStopSession', 'onError', 'onExit'];
		let enabled = true;
		let sequence = 0;
		const registration = register({
			registrationId, kind: 'debugAdapterTracker', debuggerType, operation: ['createDebugAdapterTracker', 'debugAdapterTrackerEvent'],
			async callback(context, payload, operation) {
				if (operation === 'createDebugAdapterTracker') {
					if (!enabled) { return null; }
					const tracker = await factory.createDebugAdapterTracker(context, payload.session);
					if (!enabled || tracker === undefined || tracker === null) { return null; }
					if (typeof tracker !== 'object' || operations.some(key => tracker[key] !== undefined && typeof tracker[key] !== 'function')) { throw new TypeError('Invalid Debug Adapter tracker'); }
					const trackerId = String(++sequence);
					trackers.set(trackerId, tracker);
					return { trackerId, operations: operations.filter(key => typeof tracker[key] === 'function') };
				}
				const tracker = trackers.get(payload.trackerId);
				if (payload.event === 'dispose') {
					trackers.delete(payload.trackerId);
					if (!enabled && !trackers.size) { registration.dispose(); }
					return null;
				}
				if (!operations.includes(payload.event)) { throw new TypeError('Unknown Debug Adapter tracker event'); }
				if (!tracker) { return null; }
				try {
					const args = payload.event === 'onError' ? [Object.assign(new Error(payload.message), { name: payload.name })]
						: payload.event === 'onExit' ? [payload.code ?? undefined, payload.signal ?? undefined]
							: payload.event === 'onWillReceiveMessage' || payload.event === 'onDidSendMessage' ? [payload.message] : [];
					await tracker[payload.event]?.call(tracker, context, ...args);
				} finally {
					if (payload.event === 'onExit') {
						trackers.delete(payload.trackerId);
						if (!enabled && !trackers.size) { registration.dispose(); }
					}
				}
				return null;
			},
		});
		// Disposing a factory stops creation; existing sessions keep their hooks.
		return Object.freeze({ dispose() { enabled = false; if (!trackers.size) { registration.dispose(); } } });
	},
	registerDebugAdapterDescriptorFactory(registrationId, debuggerType, factory) {
		if (typeof factory?.createDebugAdapterDescriptor !== 'function' || typeof debuggerType !== 'string' || !debuggerType) throw new TypeError('Debug adapter factories require a type and createDebugAdapterDescriptor');
		const adapters = new Map();
		let enabled = true;
		let sequence = 0;
		async function release(id, context) {
			const state = adapters.get(id);
			if (!state) { return; }
			adapters.delete(id);
			try { state.listener?.dispose(); }
			finally { state.messages = []; state.bytes = 0; try { await state.implementation.dispose(context); } finally { if (!enabled && !adapters.size) { registration.dispose(); } } }
		}
		const registration = register({
			registrationId, kind: 'debugAdapter', debuggerType,
			operation: ['createDebugAdapterDescriptor', 'sendInlineDebugAdapter', 'readInlineDebugAdapter', 'closeInlineDebugAdapter'],
			async callback(context, payload, operation) {
				if (operation === 'createDebugAdapterDescriptor') {
					if (!enabled) { throw new Error('Debug Adapter factory is disposed'); }
					const descriptor = await factory.createDebugAdapterDescriptor(context, payload.configuration, payload.session, payload.executable);
					if (descriptor === undefined || descriptor === null) return null;
					if (!descriptor?.implementation) { return descriptor; }
					const implementation = descriptor.implementation;
					if (!enabled || adapters.size >= 8) { await implementation.dispose(context); throw new Error('Inline Debug Adapter is unavailable'); }
					if (typeof implementation.handleMessage !== 'function' || typeof implementation.onDidSendMessage !== 'function' || typeof implementation.dispose !== 'function') { throw new TypeError('Inline Debug Adapter requires messages, an event and disposal'); }
					const id = `inline.${++sequence}`;
					const state = { implementation, listener: undefined, messages: [], bytes: 0, next: 0, delivered: 0, protocolError: null };
					adapters.set(id, state);
					try {
						state.listener = implementation.onDidSendMessage(message => {
							if (!adapters.has(id) || state.protocolError) { return; }
							try {
								const encoded = JSON.stringify(message);
								if (typeof encoded !== 'string' || state.messages.length >= 512 || state.bytes + encoded.length * 3 > 262144) { throw new Error('Inline Debug Adapter message queue exceeded its limit'); }
								const snapshot = JSON.parse(encoded);
								if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) { throw new TypeError('Invalid inline Debug Adapter message'); }
								state.bytes += encoded.length * 3;
								state.messages.push({ sequence: state.next++, message: snapshot, bytes: encoded.length * 3 });
							} catch (error) { state.protocolError = String(error); state.messages = []; state.bytes = 0; }
						});
						if (typeof state.listener?.dispose !== 'function') { throw new TypeError('Inline Debug Adapter event requires a disposable listener'); }
					} catch (error) { try { await release(id, context); } finally { throw error; } }
					return { inlineAdapterId: id };
				}
				if (operation === 'closeInlineDebugAdapter') { await release(payload.inlineAdapterId, context); return null; }
				const state = adapters.get(payload.inlineAdapterId);
				if (!state) { throw new Error('Inline Debug Adapter has retired'); }
				if (operation === 'sendInlineDebugAdapter') {
					if (state.protocolError) { throw new Error(state.protocolError); }
					await state.implementation.handleMessage(context, payload.message); return null;
				}
				if (!Number.isSafeInteger(payload.afterSequence) || payload.afterSequence !== state.delivered || !Number.isInteger(payload.maxMessages) || payload.maxMessages < 1 || payload.maxMessages > 128) { throw new TypeError('Invalid inline Debug Adapter cursor'); }
				const messages = state.messages.splice(0, payload.maxMessages);
				state.delivered += messages.length;
				state.bytes -= messages.reduce((sum, message) => sum + message.bytes, 0);
				return { messages: messages.map(({ sequence, message }) => ({ sequence, message })), nextSequence: state.delivered, exited: state.protocolError !== null, protocolError: state.protocolError };
			}
		});
		// Factory disposal cannot revoke IO already owned by a running session.
		activation.subscriptions.push({ async dispose() { enabled = false; let failure; for (const id of [...adapters.keys()]) { try { await release(id); } catch (error) { failure ??= error; } } registration.dispose(); if (failure) { throw failure; } } });
		return Object.freeze({ dispose() { enabled = false; if (!adapters.size) { registration.dispose(); } } });
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

// The runtime module is not resolved from extension packages; Rust owns final authority.
export const __runtime = Object.freeze({
	// The product transport owns this hook; authors receive only the vscode facade.
	onRegistrationsChanged(listener) {
		if (phase !== 'new' || registrationListener || typeof listener !== 'function') throw new Error('Invalid registration event binding');
		registrationListener = listener;
	},
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
		return JSON.stringify([...registrations.values()].map(({ callback, operation, dispatch, disposeResources, invokePayload, ...descriptor }) => descriptor));
	},
	// Browser contributions reuse the same registration and cancellation owner.
	registerContribution(descriptor, operation, callback) {
		return register(Object.defineProperties({ operation, callback, invokePayload: true }, Object.getOwnPropertyDescriptors(descriptor)));
	},
	async invoke(registrationId, payloadJson, requestId, operation, registrationGeneration) {
		if (phase !== 'active') { throw new Error('Extension is not active'); }
		const registration = registrations.get(registrationId);
		if (!registration) { throw new Error(`Registration '${registrationId}' is disposed`); }
		// Resolve and fence the handle together, before any provider callback can run.
		if (registration.kind === 'speechProvider' && registrationGeneration !== registration.registrationGeneration) { throw new Error('Speech registration generation has retired'); }
		if (!registration.dispatch && (Array.isArray(registration.operation) ? !registration.operation.includes(operation) : registration.operation !== operation)) { throw new TypeError('Invocation operation does not match its registration'); }
		const payload = JSON.parse(payloadJson);
		const source = new CancellationTokenSource();
		invocations.set(requestId, source);
		try {
			const context = Object.freeze({ cancellationToken: source.token });
			let result;
			if (registration.dispatch) {
				result = await registration.dispatch(payload, operation);
			} else if (operation === 'execute' && !registration.invokePayload) {
				if (!Array.isArray(payload.arguments)) { throw new TypeError('Command arguments must be an array'); }
				result = await registration.callback(context, ...payload.arguments);
			} else {
				result = await registration.callback(context, payload, operation);
			}
			const encoded = JSON.stringify(result === undefined ? null : result);
			if (encoded === undefined) { throw new TypeError('Command result must be a JSON value'); }
			return encoded;
		} finally {
			invocations.delete(requestId);
			source.dispose();
		}
	},
	cancel(requestId) {
		// Listener failures must not prevent revocation or cancellation of other listeners.
		try { invocations.get(requestId)?.cancel(); } catch (error) { return String(error); }
		return undefined;
	},
	async deactivate(callback) {
		try { if (typeof callback === 'function') { await callback(); } }
		finally { await this.dispose(); }
	},
	async dispose() {
		phase = 'disposed';
		registrationListener = undefined;
		let failure;
		for (const source of invocations.values()) {
			try { source.cancel(); } catch (error) { failure ??= error; }
		}
		for (const registration of registrations.values()) {
			try { registration.disposeResources?.(); } catch (error) { failure ??= error; }
		}
		registrations.clear();
		for (const subscription of activation?.subscriptions.splice(0).reverse() ?? []) {
			try { await subscription.dispose(); } catch (error) { failure ??= error; }
		}
		activation = undefined;
		if (failure) { throw failure; }
	},
});

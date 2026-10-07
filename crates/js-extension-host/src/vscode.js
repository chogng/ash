import { commands as ashCommands, languages as ashLanguages, workspace as ashWorkspace, window as ashWindow, __runtime as ashRuntime } from '@ash/extension';

// This is the public editor contract inside the confined process. Editor models and UI
// remain with the initiating client; this module owns only extension callback lifetimes.
export function createApi(configuration) {
	const titles = new Map();
	if (!Array.isArray(configuration.commands)) throw new TypeError('Invalid command contributions');
	for (const entry of configuration.commands) {
		if (typeof entry.command !== 'string' || !entry.command || typeof entry.title !== 'string' || !entry.title || titles.has(entry.command)) {
			throw new TypeError('Invalid command contribution');
		}
		titles.set(entry.command, entry.title);
	}
	const pending = new Map();
	let subscriptions;
	let providerSequence = 0;
	const documents = new Map();
	// Live documents can change during an await; diagnostic versions belong to the invocation's reads.
	const observedDocuments = new Map();
	const documentListeners = { open: new Set(), change: new Set(), close: new Set() };
	let documentRegistration;
	let collectionSequence = 0;
	const statusItems = new Map();
	const statusFlushes = new Set();
	let statusSequence = 0;
	let statusRevision = 1;
	let statusActive = false;
	let statusDisposed = false;
	const statusRegistrationId = 'vscode.statusBar';

	function statusSnapshot() {
		return { revision: statusRevision, entries: [...statusItems.values()].filter(item => item.visible).map(item => item.snapshot()) };
	}
	function statusChanged() {
		++statusRevision;
		if (!statusActive || statusDisposed || ashRuntime.isDisposed) return;
		const id = globalThis.__ashInvocation();
		const owned = pending.get(id);
		if (!owned) throw new Error('Status bar update requires an active VS Code callback');
		if (statusFlushes.has(id)) return;
		statusFlushes.add(id);
		// Coalesce synchronous property changes and keep the flush inside its originating invocation.
		const flush = Promise.resolve().then(async () => {
			statusFlushes.delete(id);
			await request({ operation: 'setStatusBarEntries', registrationId: statusRegistrationId, ...statusSnapshot() }, 'done');
		});
		owned.push(flush);
		flush.catch(() => undefined);
	}
	function checkStatusUpdate() {
		if (statusActive && !statusDisposed && !ashRuntime.isDisposed && !pending.has(globalThis.__ashInvocation(false))) throw new Error('Status bar update requires an active VS Code callback');
	}
	class StatusBarItem {
		#handle;
		#values = { text: '', name: undefined, tooltip: undefined, command: undefined, accessibilityInformation: undefined };
		#disposed = false;
		#visible = false;
		constructor(id, alignment, priority) {
			Object.defineProperties(this, { id: { value: id, enumerable: true }, alignment: { value: alignment, enumerable: true }, priority: { value: priority, enumerable: true } });
			this.#handle = `item.${++statusSequence}`;
			statusItems.set(this.#handle, this);
		}
		get visible() { return this.#visible; }
		get text() { return this.#values.text; }
		set text(value) { if (typeof value !== 'string' || value.length > 8192 || value.includes('\0')) throw new TypeError('Invalid status bar text'); this.set('text', value); }
		get name() { return this.#values.name; }
		set name(value) { if (value !== undefined && (typeof value !== 'string' || value.length > 8192 || value.includes('\0'))) throw new TypeError('Invalid status bar name'); this.set('name', value); }
		get color() { return unsupported('StatusBarItem.color'); }
		set color(_value) { return unsupported('StatusBarItem.color'); }
		get backgroundColor() { return unsupported('StatusBarItem.backgroundColor'); }
		set backgroundColor(_value) { return unsupported('StatusBarItem.backgroundColor'); }
		get tooltip() { return this.#values.tooltip; }
		set tooltip(value) { if (value !== undefined && typeof value !== 'string') return unsupported('StatusBarItem.tooltip MarkdownString'); if (value?.length > 8192 || value?.includes('\0')) throw new TypeError('Invalid status bar tooltip'); this.set('tooltip', value); }
		get command() { return this.#values.command; }
		set command(value) {
			if (value !== undefined && (typeof (typeof value === 'string' ? value : value?.command) !== 'string' || !(typeof value === 'string' ? value : value.command) || typeof value !== 'string' && value.arguments !== undefined && !Array.isArray(value.arguments))) throw new TypeError('Invalid status bar command');
			this.set('command', value);
		}
		get accessibilityInformation() { return this.#values.accessibilityInformation; }
		set accessibilityInformation(value) { if (value !== undefined && (typeof value?.label !== 'string' || value.label.length > 8192 || value.label.includes('\0'))) throw new TypeError('Invalid status bar accessibility information'); if (value?.role !== undefined && value.role !== 'button') return unsupported('StatusBarItem.accessibilityInformation.role'); this.set('accessibilityInformation', value); }
		set(key, value) { if (this.#disposed) return; if (this.#visible) checkStatusUpdate(); this.#values[key] = value; if (this.#visible) statusChanged(); }
		show() { if (this.#disposed || this.#visible) return; checkStatusUpdate(); this.#visible = true; statusChanged(); }
		hide() { if (!this.#visible) return; checkStatusUpdate(); this.#visible = false; statusChanged(); }
		dispose() {
			if (this.#disposed) return;
			this.hide();
			this.#disposed = true;
			statusItems.delete(this.#handle);
			// A retained, disposed public item must not keep its last command's argument graph alive.
			this.#values = { text: '', name: undefined, tooltip: undefined, command: undefined, accessibilityInformation: undefined };
		}
		snapshot() {
			const value = this.#values.command;
			const command = value === undefined ? null : { command: typeof value === 'string' ? value : value.command, arguments: typeof value === 'string' ? [] : value.arguments ?? [] };
			return { id: this.#handle, text: this.text, tooltip: this.tooltip ?? null, ariaLabel: this.accessibilityInformation?.label ?? this.name ?? null, alignment: this.alignment === 1 ? 'left' : 'right', priority: this.priority ?? 0, command };
		}
	}
	function createStatusBarItem(idOrAlignment, alignmentOrPriority, priority) {
		if (statusDisposed || ashRuntime.isDisposed) throw new Error('Extension is not active');
		const explicitId = typeof idOrAlignment === 'string';
		const id = explicitId ? idOrAlignment : configuration.extensionId;
		const alignment = (explicitId ? alignmentOrPriority : idOrAlignment) ?? 1;
		const order = explicitId ? priority : alignmentOrPriority;
		if (!id || id.length > 256 || ![1, 2].includes(alignment) || order !== undefined && !Number.isFinite(order)) throw new TypeError('Invalid status bar identity, alignment or priority');
		if (statusItems.size >= 128) throw new RangeError('Status bar item quota exceeded');
		return new StatusBarItem(id, alignment, order);
	}

	function unsupported(name) { throw new Error(`Unsupported VS Code API: ${name}`); }
	function contract(name, members) {
		return new Proxy(Object.freeze(members), {
			get(object, key) {
				if (key in object || typeof key === 'symbol') return Reflect.get(object, key);
				return unsupported(`${name}.${key}`);
			},
		});
	}
	function request(operation, resultKind) {
		const id = globalThis.__ashInvocation();
		const owned = pending.get(id);
		if (!owned) throw new Error('VS Code callback is no longer active');
		const promise = (async () => {
			const result = JSON.parse(await globalThis.__ashRequest(id, JSON.stringify(operation)));
			if (result.result !== resultKind) throw new Error(`Invalid result for ${operation.operation}`);
			return result;
		})();
		// Standard extensions often ignore a notification's returned Thenable. Keep its
		// request alive until it completes, without allowing detached work after retirement.
		const settled = promise.then(() => undefined, () => undefined);
		owned.push(settled);
		return promise;
	}
	async function invoke(callback) {
		const id = globalThis.__ashInvocation();
		pending.set(id, []);
		observedDocuments.set(id, new Map());
		try {
			const result = await callback();
			let drained = 0;
			const owned = pending.get(id);
			while (drained < owned.length) {
				const batch = owned.slice(drained);
				drained = owned.length;
				await Promise.all(batch);
			}
			return result;
		} finally {
			pending.delete(id);
			observedDocuments.delete(id);
		}
	}
	function message(severity, text, ...items) {
		if (typeof text !== 'string') throw new TypeError('Message must be a string');
		if (items.length) return unsupported('window message options/items');
		return request({ operation: 'showMessage', message: text, severity }, 'done').then(() => undefined);
	}
	class Disposable {
		#callback;
		constructor(callback) {
			if (typeof callback !== 'function') throw new TypeError('Disposable requires a callback');
			this.#callback = callback;
		}
		dispose() { const callback = this.#callback; this.#callback = undefined; callback?.(); }
		static from(...items) { return new Disposable(() => { for (const item of items) item.dispose(); }); }
	}
	class Position {
		constructor(line, character) {
			if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(character) || character < 0) throw new RangeError('Invalid position');
			this.line = line;
			this.character = character;
			Object.freeze(this);
		}
		compareTo(other) { return Math.sign(this.line - other.line || this.character - other.character); }
		isEqual(other) { return this.compareTo(other) === 0; }
		isBefore(other) { return this.compareTo(other) < 0; }
		isAfter(other) { return this.compareTo(other) > 0; }
		isBeforeOrEqual(other) { return this.compareTo(other) <= 0; }
		isAfterOrEqual(other) { return this.compareTo(other) >= 0; }
		translate(lineDelta = 0, characterDelta = 0) {
			if (typeof lineDelta === 'object') return this.translate(lineDelta.lineDelta ?? 0, lineDelta.characterDelta ?? 0);
			return new Position(this.line + lineDelta, this.character + characterDelta);
		}
		with(line = this.line, character = this.character) {
			if (typeof line === 'object') return this.with(line.line ?? this.line, line.character ?? this.character);
			return new Position(line, character);
		}
	}
	class Range {
		constructor(start, end, endLine, endCharacter) {
			if (typeof start === 'number') { start = new Position(start, end); end = new Position(endLine, endCharacter); }
			const first = new Position(start.line, start.character);
			const last = new Position(end.line, end.character);
			this.start = first.isBeforeOrEqual(last) ? first : last;
			this.end = first.isBeforeOrEqual(last) ? last : first;
			Object.freeze(this);
		}
		get isEmpty() { return this.start.isEqual(this.end); }
		get isSingleLine() { return this.start.line === this.end.line; }
		contains(value) {
			if (value.start && value.end) return this.contains(value.start) && this.contains(value.end);
			return this.start.isBeforeOrEqual(value) && this.end.isAfterOrEqual(value);
		}
		isEqual(other) { return this.start.isEqual(other.start) && this.end.isEqual(other.end); }
	}
	class Uri {
		constructor(scheme, authority, path, query = '', fragment = '') {
			Object.assign(this, { scheme, authority, path, query, fragment });
			Object.freeze(this);
		}
		static parse(value) {
			const match = /^([a-zA-Z][\w+.-]*):(?:(\/\/)([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
			if (!match) throw new TypeError('Invalid URI');
			return new Uri(match[1], decodeURIComponent(match[3] ?? ''), decodeURIComponent(match[4]), match[5] ?? '', match[6] ?? '');
		}
		static file(path) {
			if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError('Absolute file path required');
			return new Uri('file', '', path);
		}
		static from(components) { return new Uri(components.scheme, components.authority ?? '', components.path ?? '', components.query ?? '', components.fragment ?? ''); }
		with(change) { return Uri.from({ ...this, ...change }); }
		get fsPath() { return this.authority ? `//${this.authority}${this.path}` : this.path; }
		toString(skipEncoding = false) {
			const path = skipEncoding ? this.path : this.path.split('/').map(part => encodeURIComponent(part).replace(/%3A/gi, ':')).join('/');
			return `${this.scheme}:${this.authority || this.scheme === 'file' ? `//${this.authority}` : ''}${path}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`;
		}
		toJSON() { return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment }; }
	}
	function observeDocument(snapshot) {
		if (snapshot.uri !== undefined) observedDocuments.get(globalThis.__ashInvocation(false))?.set(snapshot.uri, snapshot.version);
	}
	function document(snapshot, live = false) {
		const key = snapshot.uri;
		observeDocument(snapshot);
		const existing = live ? documents.get(key) : undefined;
		if (existing && existing.snapshot.version > snapshot.version) return existing.value;
		if (existing) { existing.snapshot = snapshot; return existing.value; }
		const state = { snapshot, closed: false };
		const value = Object.freeze({
			uri: key === undefined ? undefined : Uri.parse(key),
			get version() { observeDocument(state.snapshot); return state.snapshot.version; },
			get languageId() { return state.snapshot.languageId; },
			get isClosed() { return state.closed; },
			get lineCount() { observeDocument(state.snapshot); return state.snapshot.text.split('\n').length; },
			getText(range) {
				observeDocument(state.snapshot);
				if (!range) return state.snapshot.text;
				return state.snapshot.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
			},
			offsetAt(position) {
				observeDocument(state.snapshot);
				const lines = state.snapshot.text.split('\n');
				if (position.line < 0) return 0;
				if (position.line >= lines.length) return state.snapshot.text.length;
				return lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + Math.max(0, Math.min(position.character, lines[position.line].replace(/\r$/, '').length));
			},
			positionAt(offset) {
				observeDocument(state.snapshot);
				const text = state.snapshot.text;
				const bounded = Math.max(0, Math.min(Math.floor(offset), text.length));
				const lines = text.slice(0, bounded).split('\n');
				return new Position(lines.length - 1, lines.at(-1).replace(/\r$/, '').length);
			},
			lineAt(line) {
				observeDocument(state.snapshot);
				const index = typeof line === 'number' ? line : line.line;
				const lines = state.snapshot.text.split('\n');
				if (!Number.isSafeInteger(index) || index < 0 || index >= lines.length) throw new RangeError('Line is outside the document');
				const text = lines[index].replace(/\r$/, '');
				return Object.freeze({ lineNumber: index, text, range: new Range(index, 0, index, text.length), rangeIncludingLineBreak: index + 1 < lines.length ? new Range(index, 0, index + 1, 0) : new Range(index, 0, index, text.length), firstNonWhitespaceCharacterIndex: text.search(/\S/) < 0 ? text.length : text.search(/\S/), isEmptyOrWhitespace: !text.trim() });
			},
			getWordRangeAtPosition(position, regex) {
				if (regex !== undefined) return unsupported('TextDocument custom word regex');
				const text = this.lineAt(position).text;
				for (const match of text.matchAll(/[\p{L}\p{N}_]+/gu)) {
					if (match.index <= position.character && position.character <= match.index + match[0].length) return new Range(position.line, match.index, position.line, match.index + match[0].length);
				}
				return undefined;
			},
		});
		state.value = value;
		if (live && key !== undefined) documents.set(key, state);
		return value;
	}
	function listenDocument(kind, listener, thisArg, disposables) {
		if (typeof listener !== 'function') throw new TypeError('Document event requires a listener');
		ensureDocumentEvents();
		const entry = { listener, thisArg };
		documentListeners[kind].add(entry);
		const disposable = new Disposable(() => documentListeners[kind].delete(entry));
		disposables?.push(disposable);
		return disposable;
	}
	function ensureDocumentEvents() {
		if (!documentRegistration) {
			documentRegistration = ashWorkspace.registerTextDocumentEvents('vscode.documents', (_call, event) => invoke(async () => {
				if (!['open', 'change', 'close'].includes(event.type) || !event.document) throw new TypeError('Invalid document event');
				const value = document(event.document, true);
				if (event.type === 'close') {
					const state = documents.get(event.document.uri);
					state.closed = true;
					documents.delete(event.document.uri);
				}
				const content = event.type === 'change' ? { document: value, contentChanges: event.contentChanges.map(change => ({ ...change, range: new Range(change.range.start, change.range.end) })), reason: event.reason === 'undo' ? 1 : event.reason === 'redo' ? 2 : undefined } : value;
				await Promise.all([...documentListeners[event.type]].map(entry => entry.listener.call(entry.thisArg, content)));
			}));
			subscriptions.push(documentRegistration);
		}
	}
	class Diagnostic {
		constructor(range, message, severity = 0) {
			if (!(range instanceof Range) || typeof message !== 'string' || !message || !Number.isInteger(severity) || severity < 0 || severity > 3) throw new TypeError('Invalid diagnostic');
			Object.assign(this, { range, message, severity });
		}
	}
	function diagnosticCollection(name = '') {
		if (typeof name !== 'string' || name.length > 256) throw new TypeError('Invalid diagnostic collection name');
		ensureDocumentEvents();
		const id = `vscode.diagnostics.${++collectionSequence}`;
		let entries = new Map();
		let disposed = false;
		function publish(next) {
			if (disposed) throw new Error('Diagnostic collection is disposed');
			if (next.size > 1024) throw new RangeError('Too many diagnostic resources');
			const payload = [...next].map(([uri, value]) => ({
				uri, version: value.version, diagnostics: value.diagnostics.map(diagnostic => {
					if (!diagnostic || ![0, 1, 2, 3].includes(diagnostic.severity) || typeof diagnostic.message !== 'string' || !diagnostic.message || !(diagnostic.range instanceof Range)) throw new TypeError('Invalid diagnostic');
					if (diagnostic.relatedInformation !== undefined || diagnostic.tags !== undefined || typeof diagnostic.code === 'object') return unsupported('Diagnostic related information/tags/code targets');
					return { start: diagnostic.range.start, end: diagnostic.range.end, message: diagnostic.message, severity: ['error', 'warning', 'information', 'hint'][diagnostic.severity], source: diagnostic.source ?? null, code: diagnostic.code === undefined ? null : String(diagnostic.code) };
				})
			}));
			request({ operation: 'setDiagnostics', collection: id, entries: payload }, 'done');
			entries = next;
		}
		return Object.freeze({
			name,
			set(uri, diagnostics) {
				if (uri === undefined) { publish(new Map()); return; }
				const values = uri instanceof Uri ? [[uri, diagnostics]] : uri;
				if (!Array.isArray(values)) throw new TypeError('Diagnostic entries must be an array');
				const next = new Map(entries);
				const merged = new Map();
				for (const [resource, items] of values) {
					if (!(resource instanceof Uri)) throw new TypeError('Diagnostic resource must be a URI');
					const key = resource.toString();
					if (items === undefined) { next.delete(key); merged.delete(key); }
					else {
						if (!Array.isArray(items) || items.length > 10_000) throw new TypeError('Invalid diagnostic list');
						const combined = [...(merged.get(key) ?? []), ...items];
						merged.set(key, combined);
						next.set(key, { version: observedDocuments.get(globalThis.__ashInvocation())?.get(key) ?? null, diagnostics: Object.freeze(combined) });
					}
				}
				publish(next);
			},
			delete(uri) { const next = new Map(entries); next.delete(uri.toString()); publish(next); },
			clear() { publish(new Map()); },
			get(uri) { if (disposed) throw new Error('Diagnostic collection is disposed'); return entries.get(uri.toString())?.diagnostics ?? []; },
			has(uri) { return entries.has(uri.toString()); },
			forEach(callback, thisArg) { for (const [uri, value] of entries) callback.call(thisArg, Uri.parse(uri), value.diagnostics, this); },
			*[Symbol.iterator]() { for (const [uri, value] of entries) yield [Uri.parse(uri), value.diagnostics]; },
			dispose() {
				if (disposed) return;
				// Deactivation has no live client invocation; the Workbench retires its owners.
				if (pending.has(globalThis.__ashInvocation(false))) publish(new Map());
				disposed = true;
				entries.clear();
			},
		});
	}
	const completionKinds = ['text', 'method', 'function', 'constructor', 'field', 'variable', 'class', 'interface', 'module', 'property', 'unit', 'value', 'enum', 'keyword', 'snippet', undefined, 'file', 'reference', 'folder', undefined, undefined, undefined, undefined, undefined, 'typeParameter'];
	const completionNames = ['Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'];
	function completionResult(value, snapshot, position) {
		const items = value == null ? [] : Array.isArray(value) ? value : value.items;
		if (!Array.isArray(items) || items.length > 10_000) throw new TypeError('Invalid completion list');
		return {
			isIncomplete: value?.isIncomplete === true, items: items.map((item, index) => {
				const label = typeof item.label === 'string' ? item.label : item.label?.label;
				if (typeof label !== 'string' || !label || (item.kind !== undefined && !completionKinds[item.kind])) throw new TypeError('Invalid completion item');
				if (item.command !== undefined || item.range?.inserting !== undefined) return unsupported('CompletionItem command/insert-replace ranges');
				const range = item.textEdit?.range ?? item.range ?? snapshot.getWordRangeAtPosition(position) ?? new Range(position, position);
				const insertion = item.textEdit?.newText ?? item.insertText ?? label;
				const result = { id: String(index), label, kind: completionKinds[item.kind ?? 0], range, insertText: insertion instanceof SnippetString ? insertion.value : insertion, insertTextFormat: insertion instanceof SnippetString ? 'snippet' : 'plainText' };
				for (const field of ['detail', 'filterText', 'sortText', 'preselect', 'commitCharacters']) if (item[field] !== undefined) result[field] = item[field];
				if (item.documentation !== undefined) result.documentation = typeof item.documentation === 'string' ? item.documentation : item.documentation.value;
				if (item.additionalTextEdits !== undefined) result.additionalTextEdits = item.additionalTextEdits.map(edit => ({ range: edit.range, text: edit.newText }));
				return result;
			})
		};
	}
	class SnippetString { constructor(value = '') { this.value = value; } }
	const api = contract('vscode', {
		StatusBarAlignment: Object.freeze({ Left: 1, Right: 2 }),
		Disposable, Position, Range, Uri, Diagnostic, SnippetString,
		DiagnosticSeverity: Object.freeze({ Error: 0, Warning: 1, Information: 2, Hint: 3 }),
		CompletionItemKind: Object.freeze(Object.fromEntries(completionNames.map((name, index) => [name, index]))),
		CompletionTriggerKind: Object.freeze({ Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 }),
		CompletionItem: class CompletionItem { constructor(label, kind) { this.label = label; this.kind = kind; } },
		CompletionList: class CompletionList { constructor(items = [], isIncomplete = false) { this.items = items; this.isIncomplete = isIncomplete; } },
		TextEdit: class TextEdit { constructor(range, newText) { this.range = range; this.newText = newText; } static replace(range, newText) { return new this(range, newText); } static insert(position, newText) { return new this(new Range(position, position), newText); } static delete(range) { return new this(range, ''); } },
		Hover: class Hover { constructor(contents, range) { this.contents = Array.isArray(contents) ? contents : [contents]; this.range = range; } },
		MarkdownString: class MarkdownString {
			constructor(value = '') { this.value = value; }
			appendText(value) { this.value += value.replace(/[\\`*_{}[\]()#+.!-]/g, '\\$&'); return this; }
			appendMarkdown(value) { this.value += value; return this; }
		},
		commands: contract('commands', {
			registerCommand(command, callback, thisArg) {
				if (typeof callback !== 'function' || !titles.has(command)) throw new TypeError('Command must be declared in package.json');
				return ashCommands.registerCommand(command, titles.get(command), (_call, ...args) => invoke(() => callback.apply(thisArg, args)));
			},
		}),
		window: contract('window', {
			createStatusBarItem,
			showInformationMessage: (text, ...items) => message('information', text, ...items),
			showWarningMessage: (text, ...items) => message('warning', text, ...items),
			showErrorMessage: (text, ...items) => message('error', text, ...items),
			async showQuickPick(items, options = {}) {
				if (!Array.isArray(items) || options.canPickMany) return unsupported('window.showQuickPick input/multi-select');
				const labels = items.map(item => typeof item === 'string' ? item : item.label);
				const { index } = await request({ operation: 'showQuickPick', items: labels, placeholder: options.placeHolder ?? '' }, 'selection');
				return index === null ? undefined : items[index];
			},
		}),
		workspace: contract('workspace', {
			get textDocuments() { return [...documents.values()].map(state => { observeDocument(state.snapshot); return state.value; }); },
			onDidOpenTextDocument: (listener, thisArg, disposables) => listenDocument('open', listener, thisArg, disposables),
			onDidChangeTextDocument: (listener, thisArg, disposables) => listenDocument('change', listener, thisArg, disposables),
			onDidCloseTextDocument: (listener, thisArg, disposables) => listenDocument('close', listener, thisArg, disposables),
			async openTextDocument(uri) {
				if (!(uri instanceof Uri)) return unsupported('workspace.openTextDocument overload');
				const result = await request({ operation: 'readDocument', uri: uri.toString() }, 'document');
				return document(result.document, true);
			},
		}),
		languages: contract('languages', {
			createDiagnosticCollection: diagnosticCollection,
			registerCompletionItemProvider(selector, provider, ...triggerCharacters) {
				ensureDocumentEvents();
				const entries = Array.isArray(selector) ? selector : [selector];
				if (entries.some(entry => typeof entry !== 'string')) return unsupported('languages.registerCompletionItemProvider selector filters');
				if (typeof provider?.provideCompletionItems !== 'function' || provider.resolveCompletionItem !== undefined) return unsupported('CompletionItemProvider missing provideCompletionItems/resolveCompletionItem');
				const registration = ashLanguages.registerCompletionProvider(`vscode.completion.${++providerSequence}`, entries, {
					provideCompletionItems: (_call, snapshot, coordinate, context) => invoke(async () => {
						const value = document(snapshot);
						const position = new Position(coordinate.line, coordinate.character);
						const result = await provider.provideCompletionItems(value, position, contract('CancellationToken', { isCancellationRequested: false }), { triggerKind: context.kind === 'triggerCharacter' ? 1 : context.kind === 'incompleteRefresh' ? 2 : 0, triggerCharacter: context.triggerCharacter });
						return completionResult(result, value, position);
					}),
				}, triggerCharacters);
				subscriptions.push(registration);
				return registration;
			},
			registerHoverProvider(selector, provider) {
				const entries = Array.isArray(selector) ? selector : [selector];
				if (entries.some(entry => typeof entry !== 'string')) return unsupported('languages.registerHoverProvider selector filters');
				const registration = ashLanguages.registerHoverProvider(`vscode.hover.${++providerSequence}`, entries, {
					provideHover: (_call, snapshot, position) => invoke(async () => {
						const hover = await provider.provideHover(document(snapshot), new Position(position.line, position.character),
							contract('CancellationToken', { isCancellationRequested: false }));
						return hover == null ? undefined : { contents: hover.contents, ...(hover.range === undefined ? {} : { range: hover.range }) };
					}),
				});
				subscriptions.push(registration);
				return registration;
			},
		}),
	});
	return Object.freeze({
		api,
		activate(context) {
			subscriptions = context.subscriptions;
			subscriptions.push(ashWindow.registerStatusBar(statusRegistrationId, statusSnapshot));
			subscriptions.push(new Disposable(() => {
				statusDisposed = true;
				statusActive = false;
				for (const item of [...statusItems.values()]) item.dispose();
				statusFlushes.clear();
			}));
		},
		didActivate() { statusActive = true; },
		deactivate() { statusActive = false; },
	});
}

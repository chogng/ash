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
			if (registrations.get(registration.registrationId) === registration) { registrations.delete(registration.registrationId); }
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

export const workspace = Object.freeze({
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
			async openTextDocument(uri) {
				const { document } = await request({ operation: 'readDocument', uri }, 'document');
				return Object.freeze({ ...document, getText() { return document.text; } });
			},
			async readTextFile(path) {
				return (await request({ operation: 'readWorkspaceFile', path }, 'file')).text;
			},
		}),
		window: Object.freeze({
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
	beginActivation(extensionId) {
		if (phase !== 'new') { throw new Error('Extension is already initialized'); }
		phase = 'activating';
		activation = Object.freeze({ extensionId, subscriptions: [] });
		return activation;
	},
	sealActivation() {
		if (phase !== 'activating') { throw new Error('Extension is not activating'); }
		phase = 'active';
		return JSON.stringify([...registrations.values()].map(({ callback, operation, ...descriptor }) => descriptor));
	},
	async invoke(registrationId, payloadJson, requestId, operation) {
		if (phase !== 'active') { throw new Error('Extension is not active'); }
		const registration = registrations.get(registrationId);
		if (!registration) { throw new Error(`Registration '${registrationId}' is disposed`); }
		if (registration.operation !== operation) { throw new TypeError('Invocation operation does not match its registration'); }
		const payload = JSON.parse(payloadJson);
		let result;
		if (operation === 'execute') {
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
		registrations.clear();
		let failure;
		for (const subscription of activation?.subscriptions.splice(0).reverse() ?? []) {
			try { subscription.dispose(); } catch (error) { failure ??= error; }
		}
		activation = undefined;
		if (failure) { throw failure; }
	},
});

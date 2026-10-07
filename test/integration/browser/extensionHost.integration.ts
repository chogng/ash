import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot, type JsonValue } from '../../../src/ash/platform/extensionHost/common/extensionHostApi.js';
import { createDisconnectedExtensionHostApi } from '../../../src/ash/platform/extensionHost/browser/extensionHostApi.js';
import { IMarkerService } from '../../../src/ash/platform/markers/common/markers.js';
import { ILanguageFeaturesService } from '../../../src/ash/editor/common/services/languageFeatures.js';
import { StandaloneServices } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { MainThreadDocuments } from '../../../src/ash/workbench/api/browser/mainThreadDocuments.js';
import { MainThreadDiagnostics } from '../../../src/ash/workbench/api/browser/mainThreadDiagnostics.js';
import { createExtensionHostLanguageProviderBatch } from '../../../src/ash/workbench/api/browser/extensionHostLanguageBridge.js';
import * as stanza from '../../../src/ash/editor/editor.main.js';

const resources = new DisposableStore();
const services = StandaloneServices.initialize();
const api = createDisconnectedExtensionHostApi(operation => { throw new Error(`Unexpected operation ${operation}`); });
services.registerInstance(IExtensionHostApi, api);
const diagnostics = resources.add(services.createInstance(MainThreadDiagnostics));
const events: JsonValue[] = [];
const completions: JsonValue[] = [];
const source = { extensionId: 'test.editor', activationGeneration: 1, incarnation: 1 };
api.invoke = async (request, signal) => {
	signal.throwIfAborted();
	if (request.operation === 'completion') {
		completions.push(request.payload);
		const { position } = request.payload as { position: { lineIndex: number; columnIndex: number; }; };
		return { isIncomplete: false, items: [{ id: 'alpha', label: 'alpha_from_extension', kind: 'function', insertText: 'alpha', insertTextFormat: 'plainText', range: { start: position, end: position } }] };
	}
	if (request.operation !== 'documentEvent') throw new Error(`Unexpected invocation ${request.operation}`);
	events.push(request.payload);
	const event = request.payload as { type: string; document: { uri: string; version: number; text: string; }; };
	diagnostics.set(source, 'lint', event.type === 'close' ? [] : [{
		uri: event.document.uri, version: event.document.version,
		diagnostics: event.document.text.includes('bad') ? [{ start: { line: 0, character: 0 }, end: { line: 0, character: 3 }, message: 'Bad word from extension', severity: 'warning', source: 'test.editor', code: 'W1' }] : [],
	}]);
	return null;
};
const documents = resources.add(services.createInstance(MainThreadDocuments, 1_000, (error: unknown) => { throw error; }));
const snapshot: ExtensionHostFleetSnapshot = {
	generation: 1, extensions: [{
		id: source.extensionId, version: '1', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1,
		activationGeneration: 1, incarnation: 1, lifecycle: 'ready', failure: undefined, stderr: '', outputEvents: [],
		registrations: [{ kind: 'textDocumentEvents', registrationId: 'documents' }],
	}]
};
diagnostics.update(snapshot);
documents.update(snapshot);
const features = services.get(ILanguageFeaturesService);
const batch = createExtensionHostLanguageProviderBatch({ kind: 'languageProvider', registrationId: 'completion', languageIds: ['plaintext'], operations: ['completion'], completionTriggerCharacters: ['.'] }, source.extensionId, 'test.completion', (operation, payload, signal) => api.invoke({ ...source, registrationId: 'completion', operation, payload, deadlineUnixMillis: Date.now() + 1_000 }, signal));
const provider = resources.add(features.registerProviderBatch(batch));
const model = resources.add(stanza.editor.createModel('bad', 'plaintext', stanza.URI.file('/main.txt')));
const editor = resources.add(stanza.editor.create(document.querySelector<HTMLElement>('#editor')!, { model }));

declare global {
	interface Window {
		extensionEditorIntegration: {
			focus(): void; events(): readonly JsonValue[]; completions(): readonly JsonValue[];
			markers(): readonly string[]; text(): string; stop(): void; close(): void; dispose(): void;
		};
	}
}
window.extensionEditorIntegration = {
	focus: () => { editor.setPosition(new stanza.Position(1, model.getLineMaxColumn(1))); editor.focus(); },
	events: () => events, completions: () => completions,
	markers: () => services.get(IMarkerService).read(model.uri).map(marker => marker.message),
	text: () => model.getValue(),
	stop: () => { documents.clear(); diagnostics.clear(); provider.replace({}); },
	close: () => { editor.setModel(null); model.dispose(); },
	dispose: () => resources.dispose(),
};

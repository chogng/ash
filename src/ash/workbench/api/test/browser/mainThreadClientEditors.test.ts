import { generalProfile } from '../../../../../../extensions/academic/browser/generalProfile.js';
import { resetNlsResolver, setNlsMessages } from '../../../../nls.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { createDefaultDocumentSchema } from '../../../../../../extensions/academic/common/model/documentSchema.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { EditorPaneOptions } from '../../../contrib/documentEditor/browser/documentEditorPane.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { startAcademyExtension } from '../../../../../../test/fixtures/academyExtension.js';
import { URI } from '../../../../base/common/uri.js';
import { IExtensionHostApi, type ExtensionHostRuntime, type JsonValue } from '../../../../platform/agentHost/common/extensionHostApi.js';
import { IExtensionApi, type ExtensionDescriptor } from '../../../../platform/extensions/common/extensionApi.js';
import { EditorPanes } from '../../../browser/editor.js';
import { type EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { DocumentTypes } from '../../../services/documentEditor/common/documentTypes.js';
import { type ExtensionEditorModuleLoader } from '../../../services/extensions/browser/extensionEditor.js';
import { MainThreadClientEditors } from '../../browser/mainThreadClientEditors.js';

const owner = { id: 'ash.academic', name: 'academic', version: '1.0.0', sourceKind: 'builtIn', packageSha256: 'a'.repeat(64) } as ExtensionDescriptor;
const declaration: { readonly [key: string]: JsonValue; } = {
	version: 1, clientModule: 'browser/editor.ts', clientDigest: `sha256:${'a'.repeat(64)}`, editors: [{
		editorId: 'stanza.editor.document', displayName: 'Academic Document', selectors: ['*.ash-academic', '*.ash-paper'],
		documentType: 'academic', contentType: 'application/vnd.ash.academic-document+json',
	}],
};
const runtime: ExtensionHostRuntime = {
	id: owner.id, version: owner.version, packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1,
	activationGeneration: 1, incarnation: 1, lifecycle: 'ready', failure: undefined, stderr: '', outputEvents: [],
	registrations: [{ kind: 'dataChannel', channelId: 'editor.client.v1', registrationId: 'editor.client.v1' }],
};

for (const [language, title] of [['en', 'Academic Document'], ['zh-CN', '学术论文文档']]) {
	test(`real Rust Academy registers its editor through the shared bridge (${language})`, async function () {
		this.timeout(60_000);
		using localization = toDisposable(resetNlsResolver);
		setNlsMessages(language, {});
		const process = await startAcademyExtension(language);
		try {
			let enabled = true;
			let createdSignal: AbortSignal | undefined;
			let loads = 0;
			const api = { invoke: (request, signal) => process.invoke(request.registrationId, request.operation, request.payload, signal) } as IExtensionHostApi;
			const packages = { list: async () => ({ generation: 1, extensions: enabled ? [owner] : [], diagnostics: [] }) } as unknown as IExtensionApi;
			const load: ExtensionEditorModuleLoader = async (name, entry) => {
				loads++;
				assert.equal(name, 'academic'); assert.equal(entry, 'browser/editor.ts');
				return {
					packageId: owner.id, packageVersion: owner.version,
					getEditorProfile: id => {
						assert.equal(id, 'stanza.editor.document');
						return { ...generalProfile, id: 'academic', contentType: 'application/vnd.ash.academic-document+json', createSchema: createDefaultDocumentSchema };
					},
				};
			};
			using bridge = new MainThreadClientEditors(30_000, load, api, packages);
			const input = { resource: URI.file('/paper.ASH-PAPER') };
			const instantiationService = {
				createInstance: (_ctor: unknown, options: EditorPaneOptions) => {
					assert.equal(options.editorId, 'stanza.editor.document');
					createdSignal = options.providerSignal;
					return {} as EditorPane;
				},
			} as unknown as IInstantiationService;
			const snapshot = { generation: 1, extensions: [{ ...runtime, registrations: process.registrations }] };
			await bridge.update(snapshot);
			const pane = EditorPanes.getEditorPane(input)!;
			assert.equal(pane.name, title);
			assert.equal(DocumentTypes.find(input)?.id, 'academic');
			assert.equal(loads, 0, 'component is loaded only when its editor opens');
			await pane.create({ input, instantiationService });
			assert.equal(loads, 1);
			const general = EditorPanes.getEditorPane({ resource: URI.file('/notes.ash-doc') })!;
			const notes = EditorPanes.getEditorPane({ resource: URI.parse('untitled:/channel/notes'), contentType: 'application/vnd.ash.channel-notes+json' })!;
			assert.equal(general.id, 'ash.editor.document');
			assert.equal(notes.id, 'ash.collaboration.notes');
			assert.equal(DocumentTypes.find({ resource: URI.file('/notes.ash-doc') })?.id, 'general');

			await bridge.update({ ...snapshot, generation: 2 });
			assert.equal(createdSignal?.aborted, false, 'an unrelated fleet update retains the registration');
			enabled = false;
			await assert.rejects(async () => pane.create({ input, instantiationService }), /retired/);
			await bridge.update({ generation: 3, extensions: [] });
			assert.equal(createdSignal?.aborted, true);
			assert.equal(EditorPanes.getEditorPane(input), undefined);
			assert.equal(DocumentTypes.find(input), undefined);
			await assert.rejects(async () => pane.create({ input, instantiationService }));
		} finally { await process.dispose(); }
	});
}

test('retired and late capability responses never restore editor registrations', async () => {
	let finish!: (value: JsonValue) => void;
	let started!: () => void;
	const requested = new Promise<void>(resolve => { started = resolve; });
	const api = { invoke: () => { started(); return new Promise<JsonValue>(resolve => { finish = resolve; }); } } as unknown as IExtensionHostApi;
	const packages = { list: async () => ({ generation: 1, extensions: [owner], diagnostics: [] }) } as unknown as IExtensionApi;
	using bridge = new MainThreadClientEditors(30_000, async () => { throw new Error('must not load'); }, api, packages);
	const pending = bridge.update({ generation: 1, extensions: [runtime] });
	await requested;
	bridge.clear();
	finish(declaration);
	await pending;
	assert.equal(EditorPanes.getEditorPane({ resource: URI.file('/late.ash-paper') }), undefined);
	await bridge.update({ generation: 3, extensions: [] });
	await bridge.update({ generation: 2, extensions: [runtime] });
	assert.equal(EditorPanes.getEditorPane({ resource: URI.file('/late.ash-paper') }), undefined);

});

test('invalid or unadmitted client declarations fail without partial registrations', async () => {
	let value: JsonValue = declaration;
	let entries = [owner];
	const api = { invoke: async () => value } as unknown as IExtensionHostApi;
	const packages = { list: async () => ({ generation: 1, extensions: entries, diagnostics: [] }) } as unknown as IExtensionApi;
	let generation = 1;
	for (const invalid of [
		{ ...declaration, version: 2 },
		{ ...declaration, clientModule: '../other/editor.ts' },
		{ ...declaration, editors: [{ ...(declaration as any).editors[0] }, { editorId: 'invalid' }] },
	]) {
		value = invalid;
		using bridge = new MainThreadClientEditors(30_000, async () => { throw new Error('must not load'); }, api, packages);
		await assert.rejects(bridge.update({ generation: generation++, extensions: [runtime] }));
		assert.equal(DocumentTypes.find({ resource: URI.file('/invalid.ash-paper') }), undefined);
	}
	value = declaration;
	entries = [{ ...owner, sourceKind: 'user' }];
	using bridge = new MainThreadClientEditors(30_000, async () => { throw new Error('must not load'); }, api, packages);
	await assert.rejects(bridge.update({ generation, extensions: [runtime] }), /unavailable/);
	entries = [owner];
	await bridge.update({ generation: generation + 1, extensions: [runtime] });
	assert.equal(DocumentTypes.find({ resource: URI.file('/retry.ash-paper') })?.id, 'academic');

});


test('retiring the connection while the catalog is loading cannot create a new editor scope', async () => {
	let resolve!: (value: unknown) => void;
	let invoked = false;
	const catalog = new Promise(resolveCatalog => { resolve = resolveCatalog; });
	using bridge = new MainThreadClientEditors(30_000, async () => { throw new Error('must not load'); }, {
		invoke: async () => { invoked = true; return declaration; },
	} as unknown as IExtensionHostApi, { list: () => catalog } as unknown as IExtensionApi);
	const pending = bridge.update({ generation: 1, extensions: [runtime] });
	bridge.clear();
	resolve({ generation: 1, extensions: [owner], diagnostics: [] });
	await pending;
	assert.equal(invoked, false);
	assert.equal(EditorPanes.getEditorPane({ resource: URI.file('/late-catalog.ash-paper') }), undefined);
});

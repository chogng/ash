import { generalProfile } from '../../../../../../extensions/academic/browser/generalProfile.js';
import { resetNlsResolver, setNlsMessages } from '../../../../nls.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
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

const owner = { id: 'ash.academic', name: 'academic', publisher: 'ash', version: '1.0.0', sourceKind: 'builtIn', packageSha256: 'a'.repeat(64) } as ExtensionDescriptor;
const declaration: { readonly [key: string]: JsonValue; } = {
	version: 1, clientModule: 'dist/editor.js', clientDigest: `sha256:${'a'.repeat(64)}`, editors: [{
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
			const load: ExtensionEditorModuleLoader = async ({ package: packageOwner, entry }) => {
				loads++;
				assert.equal(packageOwner.name, 'academic'); assert.equal(entry, 'dist/editor.js');
				return {
					packageId: owner.id, packageVersion: owner.version,
					getEditorProfile: id => {
						assert.equal(id, 'stanza.editor.document');
						return { ...generalProfile, id: 'academic', contentType: 'application/vnd.ash.academic-document+json' };
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

test('verified installed packages bind editor scopes to exact admitted runtime and package bytes', async () => {
	let entries: ExtensionDescriptor[] = [{
		...owner,
		sourceKind: 'registry',
		manifestSha256: `sha256:${'b'.repeat(64)}`,
		packageSha256: runtime.packageDigest,
		rendererClient: {
			runtimeId: 'marketplace:verified-academic:editor-extension:editor', apiVersion: 1,
			entry: 'dist/editor.js', digest: `sha256:${'c'.repeat(64)}`,
			style: 'dist/editor.css', styleDigest: `sha256:${'d'.repeat(64)}`,
			sourceDigest: declaration.clientDigest as string,
		},
	}];
	const admittedRuntime = { ...runtime, id: entries[0].rendererClient!.runtimeId };
	let loads = 0;
	let providerSignal: AbortSignal | undefined;
	const packages = { list: async () => ({ generation: 7, extensions: entries, diagnostics: [] }) } as unknown as IExtensionApi;
	using bridge = new MainThreadClientEditors(30_000, async request => {
		loads++;
		assert.strictEqual(request.package, entries[0]);
		assert.equal(request.generation, 7);
		assert.equal(request.entry, 'dist/editor.js');
		providerSignal = request.signal;
		return {
			packageId: owner.id, packageVersion: owner.version,
			getEditorProfile: () => ({ ...generalProfile, id: 'academic', contentType: 'application/vnd.ash.academic-document+json' }),
		};
	}, { invoke: async () => declaration } as unknown as IExtensionHostApi, packages);
	await bridge.update({ generation: 1, extensions: [admittedRuntime] });
	const input = { resource: URI.file('/installed.ash-paper') };
	const descriptor = EditorPanes.getEditorPane(input)!;
	assert.ok(descriptor);
	await descriptor.resolveDocumentProfile!();
	await descriptor.resolveDocumentProfile!();
	assert.equal(loads, 1, 'one capability shares one verified module across its document profiles');
	entries = [{ ...entries[0], packageSha256: `sha256:${'e'.repeat(64)}` }];
	await assert.rejects(descriptor.resolveDocumentProfile!(), /retired/);
	await assert.rejects(bridge.update({ generation: 2, extensions: [admittedRuntime] }), /unavailable/);
	assert.equal(providerSignal?.aborted, true);
	assert.equal(EditorPanes.getEditorPane(input), undefined);
});

test('a publisher name or runtime identity cannot grant installed renderer execution', async () => {
	let invoked = false;
	using bridge = new MainThreadClientEditors(30_000, async () => { throw new Error('must not load'); }, {
		invoke: async () => { invoked = true; return declaration; },
	} as unknown as IExtensionHostApi, {
		list: async () => ({ generation: 1, extensions: [{ ...owner, sourceKind: 'registry', publisher: 'ash', packageSha256: runtime.packageDigest }], diagnostics: [] }),
	} as unknown as IExtensionApi);
	await assert.rejects(bridge.update({ generation: 1, extensions: [runtime] }), /unavailable/);
	assert.equal(invoked, false);
});

test('temporary client resource failures can retry within the same live capability', async () => {
	let attempts = 0;
	using bridge = new MainThreadClientEditors(30_000, async () => {
		if (++attempts === 1) throw new Error('Temporary resource read failure');
		return { packageId: owner.id, packageVersion: owner.version, getEditorProfile: () => ({ ...generalProfile, id: 'academic', contentType: 'application/vnd.ash.academic-document+json' }) };
	}, { invoke: async () => declaration } as unknown as IExtensionHostApi, {
		list: async () => ({ generation: 1, extensions: [owner], diagnostics: [] }),
	} as unknown as IExtensionApi);
	await bridge.update({ generation: 1, extensions: [runtime] });
	const descriptor = EditorPanes.getEditorPane({ resource: URI.file('/retry-resources.ash-paper') })!;
	await assert.rejects(descriptor.resolveDocumentProfile!(), /Temporary resource read failure/);
	assert.equal((await descriptor.resolveDocumentProfile!()).id, 'academic');
	await descriptor.resolveDocumentProfile!();
	assert.equal(attempts, 2);
});

test('disabled installed declarations protect document routing and uninstall removes their reservation', async () => {
	const manifestJson = JSON.stringify({
		name: 'academic', publisher: 'ash', version: '1.0.0', ashRuntime: { kind: 'rust' },
		contributes: { customEditors: [{ viewType: 'stanza.editor.document', displayName: 'Academic', priority: 'default', selector: [{ filenamePattern: '*.ash-protected', mimeType: 'application/vnd.ash.academic-document+json' }] }] },
	});
	let entries = [{ ...owner, sourceKind: 'registry', manifestJson, manifestSha256: `sha256:${'a'.repeat(64)}` }];
	using bridge = new MainThreadClientEditors(30_000, async () => { throw new Error('must not load'); }, {} as IExtensionHostApi, {
		list: async () => ({ generation: 1, extensions: entries, diagnostics: [] }),
	} as unknown as IExtensionApi);
	const input = { resource: URI.file('/disabled.ash-protected') };
	await bridge.update({ generation: 1, extensions: [] });
	assert.equal(DocumentTypes.requiresProvider(input), true);
	assert.equal(DocumentTypes.find(input), undefined);
	entries = [];
	await bridge.update({ generation: 2, extensions: [] });
	assert.equal(DocumentTypes.requiresProvider(input), false);
});

test('package artifact capabilities validate targets and cancel conversion when the provider retires', async () => {
	const api = { invoke: async () => declaration } as unknown as IExtensionHostApi;
	const packages = { list: async () => ({ generation: 1, extensions: [owner], diagnostics: [] }) } as unknown as IExtensionApi;
	let invalid = true, started!: () => void;
	const entered = new Promise<void>(resolve => { started = resolve; });
	const load: ExtensionEditorModuleLoader = async () => ({
		packageId: owner.id, packageVersion: owner.version, getEditorProfile: () => ({
			...generalProfile, id: 'academic', contentType: 'application/vnd.ash.academic-document+json',
			create: () => ({
				...generalProfile.create(), artifactFormats: [{ id: 'test', label: 'Test', extension: invalid ? '../escape' : 'test', mimeType: 'application/test', canImport: true }], importBinary: async (_bytes, _format, _owner, signal) => {
					started(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
					throw new Error('must cancel');
				}
			}),
		})
	});
	using bridge = new MainThreadClientEditors(30_000, load, api, packages);
	await bridge.update({ generation: 1, extensions: [runtime] });
	const profile = await EditorPanes.getEditorPane({ resource: URI.file('/paper.ash-paper') })!.resolveDocumentProfile!();
	assert.throws(() => profile.create(), /Invalid document artifact format/);
	invalid = false;
	const conversion = profile.create().importBinary!(new Uint8Array(), 'test', {} as Document, new AbortController().signal);
	const outcome = assert.rejects(conversion, /abort/i);
	await entered; bridge.clear(); await outcome;
	assert.throws(() => profile.create(), /abort/i);
});

test('resource editors validate manifest scope, reserve binary resources and retire without loading a fallback', async () => {
	const manifest = {
		name: 'pdf-viewer', publisher: 'ash', version: '1.0.0', engines: { ash: '*' },
		ashRuntime: { kind: 'rust', entrypoint: 'ash-pdf-viewer' },
		contributes: { customEditors: [{ viewType: 'ash.workbench.pdfViewer', displayName: 'PDF Reader', priority: 'default', selector: [{ filenamePattern: '*.pdf', mimeType: 'application/pdf' }] }] },
	};
	const installed = { ...owner, id: 'ash.pdf-viewer', name: 'pdf-viewer', manifestJson: JSON.stringify(manifest) };
	const resourceRuntime = { ...runtime, id: installed.id, registrations: [{ kind: 'dataChannel' as const, registrationId: 'editor.resource.v1', channelId: 'editor.resource.v1' }] };
	const editor = { editorId: 'ash.workbench.pdfViewer', displayName: 'PDF Reader', selectors: ['*.pdf'], contentType: 'application/pdf' };
	let value: JsonValue = { ...declaration, editors: [editor] };
	const packages = { list: async () => ({ generation: 1, extensions: [installed], diagnostics: [] }) } as unknown as IExtensionApi;
	using bridge = new MainThreadClientEditors(30_000, async () => { throw new Error('no static implementation'); }, { invoke: async () => value } as unknown as IExtensionHostApi, packages);
	let generation = 1;
	for (const invalid of [{ ...editor, selectors: ['*.txt'] }, { ...editor, contentType: 'text/plain' }, { ...editor, documentType: 'pdf' }]) {
		value = { ...declaration, editors: [invalid] };
		await assert.rejects(bridge.update({ generation: generation++, extensions: [resourceRuntime] }));
		assert.equal(EditorPanes.getEditorPanesForInput({ resource: URI.file('/scope.pdf') }).length, 0);
	}
	value = { ...declaration, editors: [editor] };
	await bridge.update({ generation: generation++, extensions: [resourceRuntime] });
	const input = { resource: URI.file('/scope.PDF') };
	const descriptor = EditorPanes.getEditorPane(input)!;
	assert.equal(descriptor.resourceEditor, true);
	assert.equal(descriptor.documentType, undefined);
	assert.equal(EditorPanes.getEditorPane({ resource: URI.file('/scope.bin'), contentType: 'Application/PDF; charset=binary' }), descriptor);
	await assert.rejects(async () => descriptor.create({ input, instantiationService: {} as IInstantiationService }), /no static implementation/);
	await bridge.update({ generation: generation++, extensions: [] });
	assert.throws(() => EditorPanes.getEditorPane(input), /unavailable/);
	await assert.rejects(async () => descriptor.create({ input }), /abort/i);
});

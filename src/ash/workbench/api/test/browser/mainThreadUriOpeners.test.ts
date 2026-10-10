import { Registry } from '../../../../platform/registry/common/platform.js';
import '../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ExternalUriOpenerPriority, LanguageCompletionTriggerKind } from '../../../../editor/common/languages.js';
import { Position } from '../../../../editor/common/core/position.js';
import { TextModel } from '../../../../editor/common/model/textModel.js';
import { createCodeEditorServices } from '../../../../editor/test/browser/testCodeEditor.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationSchemaId, createConfigurationSchema } from '../../../../platform/configuration/common/configurationSchema.js';
import { Extensions as JSONExtensions, type IJSONContributionRegistry } from '../../../../platform/jsonschemas/common/jsonContributionRegistry.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import type { AppServerConnectionState } from '../../../../platform/agentHost/common/appServerApi.js';
import { IExtensionHostApi, normalizeExtensionHostSnapshot, type ExtensionHostFleetSnapshot, type ExtensionHostInvocationRequest, type JsonValue } from '../../../../platform/extensionHost/common/extensionHostApi.js';
import { externalUriOpenersConfigurationNode } from '../../../contrib/externalUriOpener/common/configuration.js';
import { IExternalUriOpenerService } from '../../../contrib/externalUriOpener/common/externalUriOpenerService.js';
import '../../../contrib/externalUriOpener/common/externalUriOpener.contribution.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { UserSettingsResource } from '../../../services/preferences/common/settingsEditorInput.js';
import { createJsonCompletionProvider } from '../../../services/language/common/jsonLanguageFeatures.js';
import { MainThreadUriOpeners } from '../../browser/mainThreadUriOpeners.js';

const jsonRegistry = Registry.as<IJSONContributionRegistry>(JSONExtensions.JSONContribution);

const openerId = 'extension:acme.links:browser';
function snapshot(incarnation = 1): ExtensionHostFleetSnapshot {
	return normalizeExtensionHostSnapshot({
		generation: incarnation, extensions: [{
			id: 'acme.links', version: '1', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1,
			activationGeneration: 1, incarnation, lifecycle: 'ready', failure: null, stderr: '', outputEvents: [],
			registrations: [{ kind: 'externalUriOpener', registrationId: 'browser', schemes: ['https'], label: 'Acme browser' }],
		}]
	});
}

class ExtensionHost extends Disposable implements IExtensionHostApi {
	public registerClientHandler(): { dispose(): void; } { throw new Error('Client calls are outside this fixture'); }
	private readonly changed = this._register(new Emitter<number>());
	private readonly connection = this._register(new Emitter<AppServerConnectionState>());
	public current = snapshot();
	public readonly requests: ExtensionHostInvocationRequest[] = [];
	public readonly signals: AbortSignal[] = [];
	public result: JsonValue = ExternalUriOpenerPriority.Preferred;
	public pending: Promise<JsonValue> | undefined;
	public start(): Promise<ExtensionHostFleetSnapshot> { throw new Error('Startup is outside this fixture'); }
	public isAvailable(): Promise<boolean> { return Promise.resolve(true); }
	public list(): Promise<ExtensionHostFleetSnapshot> { return Promise.resolve(this.current); }
	public reconcile(): Promise<ExtensionHostFleetSnapshot> { return this.list(); }
	public activateByEvent(): Promise<ExtensionHostFleetSnapshot> { throw new Error('Activation is outside this fixture'); }
	public getConnectionState(): Promise<AppServerConnectionState> { return Promise.resolve('ready'); }
	public onDidChange(listener: (generation: number) => void) { return this.changed.event(listener); }
	public onConnectionState(listener: (state: AppServerConnectionState) => void) { return this.connection.event(listener); }
	public invoke(request: ExtensionHostInvocationRequest, signal: AbortSignal): Promise<JsonValue> {
		this.requests.push(request);
		this.signals.push(signal);
		return this.pending ?? Promise.resolve(request.operation === 'canOpenExternalUri' ? this.result : true);
	}
	public replace(): void { this.current = snapshot(this.current.generation + 1); this.changed.fire(this.current.generation); }
	public disconnect(): void { this.connection.fire('restarting'); }
}

class Fixture extends DisposableStore {
	public readonly api = this.add(new ExtensionHost());
	public readonly services = createCodeEditorServices(this);
	public readonly opener = this.services.get(IOpenerService);
	public readonly bridge: MainThreadUriOpeners;
	constructor() {
		super();
		this.services.registerInstance(IExtensionHostApi, this.api);
		this.services.registerInstance(IPreferencesService, { openSettings: async () => { }, openGlobalKeybindingSettings: async () => { }, openUserSettings: async () => { } });
		this.services.get(IExternalUriOpenerService);
		this.bridge = this.add(this.services.createInstance(MainThreadUriOpeners, 1_000));
	}
}

test('configured extension opener receives resolved and original URLs without a capability probe', async () => {
	using fixture = new Fixture();
	await fixture.bridge.start();
	await fixture.services.get(IConfigurationService).updateValue('workbench.externalUriOpeners', { 'https://example.com': openerId });
	using resolver = fixture.opener.registerExternalUriResolver({ resolveExternalUri: async () => Object.assign(new DisposableStore(), { resolved: URI.parse('https://example.com/resolved?q=1#part') }) });
	assert.equal(await fixture.opener.open('https://source.example/docs?q=1#part', { openExternal: true, allowContributedOpeners: true }), true);
	assert.deepEqual(fixture.api.requests.map(({ operation, payload, incarnation, activationGeneration }) => ({ operation, payload, incarnation, activationGeneration })), [{
		operation: 'openExternalUri', payload: { resolvedUri: 'https://example.com/resolved?q=1#part', sourceUri: 'https://source.example/docs?q=1#part' }, incarnation: 1, activationGeneration: 1,
	}]);
	using schemaStore = new DisposableStore();
	const schemas = jsonRegistry;
	schemas.registerSchema(ConfigurationSchemaId, createConfigurationSchema(), schemaStore);
	using association = schemas.registerSchemaAssociation(ConfigurationSchemaId, UserSettingsResource.toString());
	using settings = new TextModel('{"workbench.externalUriOpeners":{"*":""}}');
	const suggestions = await createJsonCompletionProvider(schemas).provideCompletions({
		requestId: 1, languageId: 'jsonc', resource: UserSettingsResource, position: new Position(1, 39),
		context: { kind: LanguageCompletionTriggerKind.Invoke }, snapshot: settings.createVersionedSnapshot(),
	}, new AbortController().signal);
	assert.deepEqual(suggestions?.items.map(item => [item.label, item.detail]), [
		['"default"', 'Open in default browser'], ['"ash.browser.open"', 'Open in Ash browser'], [JSON.stringify(openerId), 'Acme browser'],
	]);
});

test('extension URI opener respects schemes, priority and stable IDs across restarts', async () => {
	using fixture = new Fixture();
	await fixture.bridge.start();
	const service = fixture.services.get(IExternalUriOpenerService);
	const uri = URI.parse('https://example.com/docs');
	assert.equal((await service.getOpener(uri, { sourceUri: uri }, CancellationToken.None))?.id, openerId);
	assert.deepEqual(fixture.api.requests[0]!.payload, { uri: uri.toString() });
	assert.equal(await service.getOpener(URI.parse('http://example.com'), { sourceUri: uri, preferredOpenerId: openerId }, CancellationToken.None), undefined);
	fixture.api.replace();
	const fresh = await service.getOpener(uri, { sourceUri: uri }, CancellationToken.None);
	assert.equal(fresh?.id, openerId);
	assert.equal(fixture.api.requests.at(-1)!.incarnation, 2);
	fixture.api.result = 99;
	assert.equal(await service.getOpener(uri, { sourceUri: uri }, CancellationToken.None), undefined);
	fixture.api.disconnect();
	assert.equal(await service.getOpener(uri, { sourceUri: uri, preferredOpenerId: openerId }, CancellationToken.None), undefined);
	assert.doesNotMatch(JSON.stringify(externalUriOpenersConfigurationNode.schema), /acme\.links/);
});

test('caller cancellation and revoked extension registrations reject late open results', async () => {
	using fixture = new Fixture();
	await fixture.bridge.start();
	const uri = URI.parse('https://example.com/docs');
	const handler = (await fixture.services.get(IExternalUriOpenerService).getOpener(uri, { sourceUri: uri, preferredOpenerId: openerId }, CancellationToken.None))!;
	for (const cancel of ['caller', 'connection'] as const) {
		const deferred = new DeferredPromise<JsonValue>();
		fixture.api.pending = deferred.p;
		using source = new CancellationTokenSource();
		const opening = handler.openExternalUri(uri, { sourceUri: uri }, source.token);
		if (cancel === 'caller') { source.cancel(); } else { fixture.api.disconnect(); }
		assert.equal(fixture.api.signals.at(-1)!.aborted, true);
		await deferred.complete(true);
		await assert.rejects(opening);
	}
});

test('extension opener admission rejects unknown fields and invalid scheme lists', () => {
	for (const schemes of [[], ['https', 'https'], ['file'], ['http', 'https', 'http']]) {
		const input = JSON.parse(JSON.stringify(snapshot()));
		input.extensions[0].failure = null;
		input.extensions[0].registrations[0].schemes = schemes;
		assert.throws(() => normalizeExtensionHostSnapshot(input));
	}
	const input = JSON.parse(JSON.stringify(snapshot()));
	input.extensions[0].failure = null;
	input.extensions[0].registrations[0].unexpected = true;
	assert.throws(() => normalizeExtensionHostSnapshot(input));
});

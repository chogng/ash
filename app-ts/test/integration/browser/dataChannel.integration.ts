import { createCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { ExternalUriOpenerPriority } from '../../../src/ash/editor/common/languages.js';
import { MainThreadUriOpeners } from '../../../src/ash/workbench/api/browser/mainThreadUriOpeners.js';
import { ExternalUriOpenerService, IExternalUriOpenerService } from '../../../src/ash/workbench/contrib/externalUriOpener/common/externalUriOpenerService.js';
import '../../../src/ash/workbench/contrib/externalUriOpener/common/externalUriOpener.contribution.js';
import { IPreferencesService } from '../../../src/ash/workbench/services/preferences/common/preferences.js';
import { Emitter } from '../../../src/ash/base/common/event.js';
import { Disposable, DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import type { AppServerConnectionState } from '../../../src/ash/platform/app-server/common/appServerApi.js';
import { IContextKeyService, ContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IDataChannelService, ILinkPresentationService } from '../../../src/ash/platform/dataChannel/common/dataChannel.js';
import { DataChannelForwardingTelemetryService } from '../../../src/ash/platform/dataChannel/browser/forwardingTelemetryService.js';
import { IExtensionHostApi, normalizeExtensionHostSnapshot, type ExtensionHostFleetSnapshot, type ExtensionHostInvocationRequest, type JsonValue } from '../../../src/ash/platform/extensionHost/common/extensionHostApi.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../src/ash/platform/log/common/log.js';
import { ITelemetryService } from '../../../src/ash/platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../src/ash/platform/telemetry/common/telemetryUtils.js';
import { MainThreadDataChannels } from '../../../src/ash/workbench/api/browser/mainThreadDataChannels.js';
import { ChatListWidget } from '../../../src/ash/workbench/contrib/chat/browser/widget/chatListWidget.js';
import { DataChannelService, LinkPresentationService } from '../../../src/ash/workbench/services/dataChannel/browser/dataChannelService.js';

class ExtensionHost extends Disposable implements IExtensionHostApi {
	public registerClientHandler(): { dispose(): void } { throw new Error('Client calls are outside this fixture'); }
	private readonly changes = this._register(new Emitter<number>());
	private readonly connection = this._register(new Emitter<AppServerConnectionState>());
	private incarnation = 1;
	public title = 'Issue one';
	public state: AppServerConnectionState = 'ready';
	public readonly delivery = document.createElement('output');
	public readonly uriDelivery = document.createElement('output');
	public isAvailable(): Promise<boolean> { return Promise.resolve(true); }
	public list(): Promise<ExtensionHostFleetSnapshot> {
		return Promise.resolve(normalizeExtensionHostSnapshot({ generation: this.incarnation, extensions: [{
			id: 'test.links', version: '1', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1,
			activationGeneration: 1, incarnation: this.incarnation, lifecycle: 'ready', failure: null, stderr: '', outputEvents: [],
			registrations: [
				{ kind: 'dataChannel', registrationId: 'edits', channelId: 'editTelemetry' },
				{ kind: 'externalUriOpener', registrationId: 'browser', schemes: ['https'], label: 'Extension browser' },
				{ kind: 'linkPresentationProvider', registrationId: 'issues', uriPattern: '^https://example\\.com/issues/', presentationKind: 'issue' },
			],
		}] }));
	}
	public reconcile(): Promise<ExtensionHostFleetSnapshot> { return this.list(); }
	public activateByEvent(): Promise<ExtensionHostFleetSnapshot> { throw new Error('Activation is outside this fixture'); }
	public getConnectionState(): Promise<AppServerConnectionState> { return Promise.resolve(this.state); }
	public onDidChange(listener: (generation: number) => void) { return this.changes.event(listener); }
	public onConnectionState(listener: (state: AppServerConnectionState) => void) { return this.connection.event(listener); }
	public invoke(request: ExtensionHostInvocationRequest, signal: AbortSignal): Promise<JsonValue> {
		signal.throwIfAborted();
		if (request.operation === 'canOpenExternalUri') { return Promise.resolve(ExternalUriOpenerPriority.Option); }
		if (request.operation === 'openExternalUri') {
			this.uriDelivery.textContent = JSON.stringify({ incarnation: request.incarnation, payload: request.payload });
			return Promise.resolve(true);
		}
		if (request.operation === 'receiveData') {
			this.delivery.textContent = JSON.stringify(request.payload);
			return Promise.resolve(null);
		}
		return Promise.resolve({ kind: 'issue', title: this.title, reference: '#1', status: { kind: 'open', label: 'Open' }, changes: { insertions: 2, deletions: 1 } });
	}
	public replace(): void {
		this.title = '<img src=x onerror=alert(1)>';
		this.changes.fire(++this.incarnation);
	}
	public disconnect(): void { this.state = 'restarting'; this.connection.fire(this.state); }
}

const resources = new DisposableStore();
const api = resources.add(new ExtensionHost());
const services = resources.add(new InstantiationService());
services.registerInstance(IExtensionHostApi, api);
services.registerInstance(ILogService, new NullLoggerService());
services.registerInstance(ITelemetryService, NullTelemetryService);
services.registerSingleton(IContextKeyService, () => new ContextKeyService());
services.registerSingleton(IDataChannelService, () => new DataChannelService());
services.registerSingleton(ILinkPresentationService, () => services.createInstance(LinkPresentationService));
const bridge = resources.add(services.createInstance(MainThreadDataChannels, 1_000));
await bridge.start();
const editorServices = createCodeEditorServices(resources, services);
editorServices.registerInstance(IPreferencesService, { openSettings: async () => {}, openGlobalKeybindingSettings: async () => {}, openUserSettings: async () => {} });
editorServices.registerInstance(IExternalUriOpenerService, resources.add(editorServices.createInstance(ExternalUriOpenerService)));
const uriBridge = resources.add(editorServices.createInstance(MainThreadUriOpeners, 1_000));
await uriBridge.start();
await editorServices.get(IConfigurationService).updateValue('workbench.externalUriOpeners', { 'https://example.com': 'extension:test.links:browser' });
const opener = editorServices.get(IOpenerService);
const container = document.createElement('main');
const opened = document.createElement('output');
opened.setAttribute('aria-label', 'Opened target');
api.delivery.setAttribute('aria-label', 'Extension channel delivery');
api.uriDelivery.setAttribute('aria-label', 'Extension URL delivery');
document.body.append(container, opened, api.delivery, api.uriDelivery);
const widget = resources.add(editorServices.createInstance(ChatListWidget, container, { onDidRequestLink: (target: string) => { opened.textContent = target; void opener.open(target, { openExternal: true, fromUserGesture: true, allowContributedOpeners: true }); } }));
opener.setDefaultExternalOpener({ openExternal: async href => { api.uriDelivery.textContent = `default:${href}`; return true; } });
widget.setVisible(true);
widget.render([{ id: 'message', type: 'agentMessage', text: '[Original issue](https://example.com/issues/1) and [Plain link](https://example.org/)', transient: false }]);
const telemetry = services.createInstance(DataChannelForwardingTelemetryService);
const publish = document.createElement('button');
publish.textContent = 'Publish edit event';
publish.addEventListener('click', () => telemetry.publicLog('inlineCompletion.endOfLife', { accepted: true, durationMs: 5 }));
const replace = document.createElement('button');
replace.textContent = 'Replace extension';
// Preserve link focus while publishing a new process registration.
replace.addEventListener('click', () => { container.querySelector<HTMLAnchorElement>('a')!.focus(); api.replace(); });
const disconnect = document.createElement('button');
disconnect.textContent = 'Disconnect';
disconnect.addEventListener('click', () => api.disconnect());
document.body.append(publish, replace, disconnect);
window.addEventListener('pagehide', () => resources.dispose(), { once: true });

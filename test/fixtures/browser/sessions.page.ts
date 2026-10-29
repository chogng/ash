import { sessionIdentity } from '../../../src/ash/sessions/services/sessions/common/sessionIdentity.js';
import { installMultiHostSessionsFixture } from './multiHostSessionsFixture.js';
import { errorHandler } from '../../../src/ash/base/common/errors.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { IUpdateService, type UpdateCheckResult, type UpdateReadyResult, type UpdateState } from '../../../src/ash/platform/update/common/updateService.js';
import { DeferredPromise } from '../../../src/ash/base/common/async.js';
import { getSingletonServiceDescriptors } from '../../../src/ash/platform/instantiation/common/extensions.js';
import { SyncDescriptor } from '../../../src/ash/platform/instantiation/common/descriptors.js';
import { createDisconnectedRendererApi } from '../../../src/ash/workbench/browser/rendererApi.js';
import type { } from '../../../src/ash/workbench/browser/web.api.js';
import { codeSessionsProfile } from '../../../src/ash/code/common/codeSessionsProfile.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { WorkbenchThemesRegistry } from '../../../src/ash/workbench/common/theme.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { installDebugClientFixture } from '../../../src/ash/workbench/contrib/debug/test/common/debugClientFixture.js';

if (new URL(location.href).searchParams.get('locale') === 'zh-CN') {
	setNlsMessages('zh-CN', productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
}
await import('../../../src/ash/sessions/sessions.web.main.js');
const updateChanges = new Emitter<UpdateState>();
let updateState: UpdateState = new URL(location.href).searchParams.get('update') === 'ready' ? 'ready' : 'idle';
let updateInstallCount = 0;
let updateInstallation: DeferredPromise<void> | undefined;
window.addEventListener('pagehide', () => updateChanges.dispose(), { once: true });
if (new URL(location.href).searchParams.has('update')) {
	// Select the fixture provider before the real SidebarPart resolves its service.
	getSingletonServiceDescriptors().find(([id]) => id === IUpdateService)![1] = new SyncDescriptor(class implements IUpdateService {
		get state(): UpdateState { return updateState; }
		readonly onDidChangeState = updateChanges.event;
		async checkForUpdates(): Promise<UpdateCheckResult> { return { status: 'current' }; }
		async checkAutomatically(): Promise<undefined> { return undefined; }
		async downloadUpdate(): Promise<UpdateReadyResult> { throw new Error('Unexpected fixture download'); }
		async installUpdate(): Promise<void> {
			updateInstallCount++;
			updateState = 'installing';
			updateChanges.fire(updateState);
			updateInstallation = new DeferredPromise<void>();
			try {
				await updateInstallation.p;
			} catch (error) {
				updateState = 'ready';
				updateChanges.fire(updateState);
				throw error;
			}
		}
	});
}
const { SessionsBrowserMain } = await import('../../../src/ash/sessions/browser/web.main.js');

// Mount the renderer's real Parts, settings and canvas without a product process or backend.
// A disconnected host that advertises automation still owns its saved management entry.
const disconnectedApi = createDisconnectedRendererApi();
globalThis.ashWebWorkbenchHost = {
	api: {
		...disconnectedApi,
		// Policy startup reads account order even when no account is signed in.
		github: { ...disconnectedApi.github, listAccounts: async () => [] },
	}
};
if (new URL(location.href).searchParams.has('search') || new URL(location.href).searchParams.has('sidebarGroups')) {
	const updatedAt = new URL(location.href).searchParams.get('projectUpdatedAt');
	const createdAt = new URL(location.href).searchParams.get('projectCreatedAt');
	const project = {
		id: 'search-project', revision: 1, name: 'Search project fixture', archived: false, sessionCount: 0,
		description: 'Synthetic project for Search navigation', materials: [],
		sessionIds: new URL(location.href).searchParams.has('sidebarGroups') ? [sessionIdentity('Host A', 'same', 'local-agent-host')] : [],
		updatedAtMs: updatedAt === null ? undefined : Number(updatedAt), createdAtMs: createdAt === null ? undefined : Number(createdAt),
	};
	const unexpectedAutomation = async (): Promise<never> => { throw new Error('Search must not mutate or run the fixture schedule'); };
	globalThis.ashWebWorkbenchHost = {
		api: {
			...globalThis.ashWebWorkbenchHost!.api,
			projects: { ...disconnectedApi.projects, list: async () => [project], read: async () => project },
			automation: {
				onDidChange: Event.None,
				list: async () => [{
					id: 'search-schedule', revision: 1, status: 'enabled', createdAt: 1, updatedAt: 1, nextRunAt: null,
					definition: { title: 'Daily search fixture', prompt: 'Synthetic schedule for Search navigation', directory: '/tmp/search-fixture', session: { type: 'new' }, schedule: { type: 'interval', anchor: 1, minutes: 1440 } },
				}],
				runs: async () => [], preview: async () => [],
				save: unexpectedAutomation, delete: unexpectedAutomation, run: unexpectedAutomation,
				getRun: unexpectedAutomation, stop: unexpectedAutomation, readResult: async () => ({ output: '', files: [] }),
			},
		},
	};
}
// Synthetic catalogs exercise the real Sessions composition without using a personal profile.
if (new URL(location.href).searchParams.has('customize')) {
	const catalog = { generation: 1, skills: ['research-notes', 'code-review', 'writing-guide'].map(name => ({
		id: { source: 'fixture', name }, description: `Reusable ${name.toLowerCase()} instructions with a deliberately long description to verify card wrapping without pushing actions outside the page.`,
		metadata: { author: 'Ash fixtures' }, contentDigest: 'a'.repeat(64), enabled: true, compatible: true,
	})) };
	const summaries = ['Data explorer', 'Document studio', 'Team knowledge', 'Writing companion'].map((displayName, index) => ({
		id: `fixture.package-${index}`, version: '1.0.0', packageType: 'plugin', displayName, description: `Tools and reusable instructions for ${displayName.toLowerCase()}.`,
	}));
	globalThis.ashWebWorkbenchHost = { api: {
		...globalThis.ashWebWorkbenchHost!.api,
		skills: { ...disconnectedApi.skills, list: async () => catalog, read: async () => ({ revision: 1, catalog, diagnostics: [] }) },
		plugins: { ...disconnectedApi.plugins, list: async () => ({ revision: 1, activationGeneration: 1, packages: [{
			id: 'fixture.local', version: '1.0.0', digest: 'a'.repeat(64), displayName: 'Local productivity', permissions: [],
			hasEditorExtensions: true, enabled: true, granted: false, effective: false, revoked: false,
		}] }) },
		connectors: { ...disconnectedApi.connectors, list: async () => ({ generation: 1, connectors: [{
			id: 'fixture.connector', displayName: 'Team library', description: 'Search shared project documents.', runtimeServerId: 'fixture.mcp', mcpServerId: null,
			definitionDigest: 'a'.repeat(64), connectionGeneration: 1, enabled: false, state: { status: 'disconnected' },
			availableActions: [], oauthMethods: [], credentialCleanupPending: false,
		}] }) },
		extensionManagement: {
			...disconnectedApi.extensionManagement,
			listInstalled: async () => ({ instanceId: 'fixture', generation: 1, packages: [] }),
			sources: async () => ({ revision: 1, sources: [{ id: 'Ash fixtures', kind: 'ash', enabled: true, productOwned: true }] }),
			search: async ({ query }) => ({ unavailableSources: [], packages: summaries.filter(item => item.displayName.toLowerCase().includes(query.toLowerCase())) }),
			searchPage: async ({ query, cursor }) => {
				if (query === 'error') throw new Error('Synthetic catalog failure');
				const matches = summaries.filter(item => item.displayName.toLowerCase().includes(query.toLowerCase()));
				return { packages: matches.slice(cursor ? 2 : 0, cursor ? 4 : 2), total: BigInt(matches.length), nextCursor: !cursor && matches.length > 2 ? 'page-two' : null };
			},
			get: async ({ packageId }) => {
				const summary = summaries.find(item => item.id === packageId)!;
				return { ...summary, package: { id: summary.id, version: summary.version, digest: 'a'.repeat(64) }, license: 'MIT', source: 'official', upstream: null,
					capabilities: [{ kind: 'skill', id: 'fixture-skill', contractVersion: '1', permissions: [], authenticationProvider: null }] };
			},
		},
	} };
}
// Sessions Parts need startup workspace storage while debugger processes remain outside this fixture.
const unexpectedTransport = async (): Promise<never> => { throw new Error('Sessions component tests must not launch or use a debug adapter'); };
globalThis.ashWebWorkbenchHost = {
	api: {
		...globalThis.ashWebWorkbenchHost!.api,
		debugAdapter: installDebugClientFixture({
			start: unexpectedTransport, send: unexpectedTransport, read: unexpectedTransport, close: unexpectedTransport,
			getConnectionState: async () => 'stopped', onConnectionState: Event.None,
		}),
	},
};
if (new URL(location.href).searchParams.has('automations')) {
	globalThis.ashWebWorkbenchHost = {
		api: {
			...globalThis.ashWebWorkbenchHost!.api, automation: {
				onDidChange: Event.None, list: async () => [], runs: async () => [],
				getRun: async () => { throw new Error('Unexpected automation run lookup'); },
				preview: async () => [], readResult: async () => ({ output: '', files: [] }),
				save: async () => { throw new Error('Unexpected automation save'); },
				delete: async () => { throw new Error('Unexpected automation delete'); },
				run: async () => { throw new Error('Window restoration must not run automations'); },
				stop: async () => { throw new Error('Window disposal must not stop automations'); },
			}
		}
	};
}
const themes = WorkbenchThemesRegistry.registerColorThemes([darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme]);
window.addEventListener('pagehide', () => themes.dispose(), { once: true });
const initialErrorHandler = errorHandler.getUnexpectedErrorHandler();
const multiHost = new URL(location.href).searchParams.has('multiHost') ? installMultiHostSessionsFixture() : undefined;
let main = new SessionsBrowserMain(document.querySelector<HTMLElement>('#app')!, codeSessionsProfile);
window.addEventListener('pagehide', () => main.dispose(), { once: true });
let workbench = await main.open();
const errors: string[] = [];
const errorDetails: string[] = [];
const stopObservingErrors = errorHandler.addListener(error => { errors.push(String(error)); errorDetails.push(error instanceof Error ? error.stack ?? String(error) : String(error)); });
window.addEventListener('pagehide', stopObservingErrors, { once: true });

declare global {
	interface Window {
		ashSessionsIntegration: {
			readonly errors: readonly string[];
			readonly multiHost?: ReturnType<typeof installMultiHostSessionsFixture>;
			readonly errorDetails: readonly string[];
			takeErrors(): string[];
			disposeAndCheckErrorHandler(): Promise<boolean>;
			remountAfterDirectDispose(): Promise<void>;
			openChat(): Promise<void>;
			setTheme(id: string): Promise<void>;
			updateConfiguration(key: string, value: unknown): Promise<void>;
			setUpdateState(value: UpdateState): void;
			getUpdateInstallCount(): number;
			finishUpdateInstall(fail: boolean): Promise<void>;
		};
	}
}

window.ashSessionsIntegration = {
	errors, errorDetails, multiHost,
	setUpdateState: value => { updateState = value; updateChanges.fire(value); },
	getUpdateInstallCount: () => updateInstallCount,
	finishUpdateInstall: async fail => {
		if (fail) await updateInstallation!.error(new Error('Synthetic install failure'));
		else await updateInstallation!.complete();
	},
	openChat: () => workbench.acceptHandoff({}),
	takeErrors: () => { errorDetails.splice(0); return errors.splice(0); },
	disposeAndCheckErrorHandler: async () => {
		await workbench.shutdown('windowClose');
		main.dispose();
		return errorHandler.getUnexpectedErrorHandler() === initialErrorHandler;
	},
	remountAfterDirectDispose: async () => {
		main.dispose();
		main = new SessionsBrowserMain(document.querySelector<HTMLElement>('#app')!, codeSessionsProfile);
		workbench = await main.open();
	},
	setTheme: id => workbench.configurationService.updateValue('workbench.colorTheme', id),
	updateConfiguration: (key, value) => workbench.configurationService.updateValue(key, value),
};
document.body.dataset.ready = 'true';

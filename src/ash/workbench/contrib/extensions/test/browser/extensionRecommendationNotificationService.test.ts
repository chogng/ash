import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { URI } from '../../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IExtensionManagementService } from '../../../../../platform/extensionManagement/common/extensionManagementService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensionService.js';
import { IWorkspaceExtensionsConfigService } from '../../../../services/extensionRecommendations/common/workspaceExtensionsConfig.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { RecommendationSource, RecommendationsNotificationResult } from '../../../../../platform/extensionRecommendations/common/extensionRecommendations.js';
import { TestConfigurationService, TestWorkspaceService } from '../../../../services/configuration/test/common/testServices.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IExtensionIgnoredRecommendationsService } from '../../../../services/extensionRecommendations/common/extensionRecommendations.js';
import { ExtensionIgnoredRecommendationsService } from '../../../../services/extensionRecommendations/common/extensionIgnoredRecommendationsService.js';
import { TestNotificationService } from '../../../../services/notification/test/common/testNotificationService.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import type { NotificationItem } from '../../../../common/notifications.js';

const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://recommendations.test' });
for (const [key, value] of Object.entries({
	window: browser.window,
	document: browser.window.document,
	Node: browser.window.Node,
	HTMLElement: browser.window.HTMLElement,
})) {
	Object.defineProperty(globalThis, key, { configurable: true, value });
}
const { ExtensionRecommendationNotificationService } = await import('../../browser/extensionRecommendationNotificationService.js');
await import('../../browser/extensions.contribution.js');
const recommendation = { source: RecommendationSource.FILE, extensions: ['ash.academy@ash'], name: 'Docs' };

function fixture(
	options: {
		installed?: boolean;
		excluded?: boolean;
		offline?: boolean;
		installedError?: boolean;
		lookup?: DeferredPromise<void>;
	} = {},
) {
	browser.window.localStorage.clear();
	const lifetime = new DisposableStore();
	const services = lifetime.add(new InstantiationService());
	const configuration = lifetime.add(new TestConfigurationService());
	const storage = lifetime.add(
		new BrowserStorageService({
			ownerWindow: browser.window as unknown as Window,
			workspaceId: 'recommendations',
			backend: browser.window.localStorage,
			flushInterval: 0,
		}),
	);
	const notifications = lifetime.add(new TestNotificationService());
	const commands: unknown[][] = [];
	const installedChanged = lifetime.add(new Emitter<void>());
	let lookupCount = 0;
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IStorageService, storage);
	services.registerInstance(IWorkspaceContextService, lifetime.add(new TestWorkspaceService({ id: 'project', uri: URI.file('/fixture') })));
	services.registerInstance(INotificationService, notifications);
	services.registerInstance(ICommandService, {
		executeCommand: async (...args: unknown[]) => {
			commands.push(args);
		},
	} as unknown as ICommandService);
	services.registerInstance(IDialogService, {
		confirm: async () => ({ confirmed: false }),
	} as unknown as IDialogService);
	services.registerInstance(IExtensionService, {
		currentCatalog: { extensions: [], generation: 1, diagnostics: [] },
	} as unknown as IExtensionService);
	services.registerInstance(IWorkspaceExtensionsConfigService, {
		onDidChangeExtensionsConfigs: Event.None,
		refresh() {},
		getExtensionsConfigs: async () =>
			options.excluded
				? [
						{
							resource: URI.file('/fixture/.ash/extensions.json'),
							recommendations: [],
							unwantedRecommendations: ['ASH.ACADEMY'],
						},
					]
				: [],
	});
	services.registerInstance(IExtensionManagementService, {
		onDidChangeInstalled: installedChanged.event,
		listInstalled: async () => {
			if (options.installedError) {
				throw new Error('Connection unavailable');
			}
			return options.installed ? [{ package: { id: 'ash.academy@ash' } }] : [];
		},
		get: async (id: string) => {
			++lookupCount;
			if (options.lookup) {
				await options.lookup.p;
			}
			if (options.offline) {
				throw new Error('offline registry');
			}
			return {
				package: { id, version: '1' },
				displayName: id.toLowerCase() === 'ash.academy@ash' ? 'Rich documents' : id,
				description: '',
				packageType: 'editor',
			};
		},
	} as unknown as IExtensionManagementService);
	const ignored = lifetime.add(services.createInstance(ExtensionIgnoredRecommendationsService));
	services.registerInstance(IExtensionIgnoredRecommendationsService, ignored);
	return {
		lifetime,
		services,
		configuration,
		storage,
		notifications,
		commands,
		installedChanged,
		ignored,
		get lookupCount() {
			return lookupCount;
		},
		create: () => lifetime.add(services.createInstance(ExtensionRecommendationNotificationService)),
	};
}

function nextNotification(notifications: TestNotificationService): Promise<NotificationItem> {
	const result = new DeferredPromise<NotificationItem>();
	const subscription = notifications.model.onDidAdd(item => {
		subscription.dispose();
		result.complete(item);
	});
	return result.p;
}

suite('Contextual extension recommendation notifications', () => {
	test('suggests an installable extension once and opens the existing marketplace on explicit action', async () => {
		const f = fixture();
		using lifetime = f.lifetime;
		const service = f.create();
		const added = nextNotification(f.notifications);
		const result = service.promptImportantExtensionsInstallNotification(recommendation);
		const item = await added;
		assert.match(item.message, /Docs.*Rich documents/u);
		assert.equal(await service.promptImportantExtensionsInstallNotification(recommendation), RecommendationsNotificationResult.Ignored);
		await item.actions?.primary?.find(action => action.id.endsWith('.show'))?.run();
		assert.equal(await result, RecommendationsNotificationResult.Accepted);
		assert.deepEqual(f.commands, [['ash.extensions.open', { mode: 'browse', query: 'Rich documents' }]]);
		assert.equal(f.lookupCount, 1);
	});

	test('filters installed, workspace-excluded and explicitly disabled suggestions before registry access', async () => {
		for (const options of [{ installed: true }, { excluded: true }]) {
			const f = fixture(options);
			using lifetime = f.lifetime;
			assert.equal(await f.create().promptImportantExtensionsInstallNotification(recommendation), RecommendationsNotificationResult.Ignored);
			assert.equal(f.lookupCount, 0);
		}
		const f = fixture();
		using lifetime = f.lifetime;
		await f.configuration.write('{"extensions.ignoreRecommendations":true}');
		assert.equal(await f.create().promptImportantExtensionsInstallNotification(recommendation), RecommendationsNotificationResult.Ignored);
		assert.equal(f.lookupCount, 0);
	});

	test('never show again persists by extension identity across window service instances', async () => {
		const f = fixture();
		using lifetime = f.lifetime;
		const added = nextNotification(f.notifications);
		const result = f.create().promptImportantExtensionsInstallNotification(recommendation);
		const item = await added;
		await item.actions?.secondary?.[0].run();
		await result;
		const reopened = f.create();
		assert.deepEqual(reopened.ignoredRecommendations, ['ash.academy']);
		assert.equal(await reopened.promptImportantExtensionsInstallNotification(recommendation), RecommendationsNotificationResult.Ignored);
		f.storage.store('extensionsAssistant/importantRecommendationsIgnore', '{broken', StorageScope.PROFILE, StorageTarget.USER);
		assert.deepEqual(reopened.ignoredRecommendations, []);
	});

	test('offline registries do not interrupt editing and window shutdown settles an open suggestion', async () => {
		const offline = fixture({ offline: true });
		using offlineLifetime = offline.lifetime;
		assert.equal(await offline.create().promptImportantExtensionsInstallNotification(recommendation), RecommendationsNotificationResult.Ignored);
		assert.equal(offline.notifications.model.getNotifications().length, 0);
		const f = fixture();
		using lifetime = f.lifetime;
		const service = f.create();
		const added = nextNotification(f.notifications);
		const result = service.promptImportantExtensionsInstallNotification(recommendation);
		await added;
		service.dispose();
		assert.equal(await result, RecommendationsNotificationResult.Cancelled);
		assert.equal(f.notifications.model.getNotifications().length, 0);
	});

	test('simultaneous file and workspace sources reserve a package once', async () => {
		const f = fixture();
		using lifetime = f.lifetime;
		const service = f.create();
		const added = nextNotification(f.notifications);
		const file = service.promptImportantExtensionsInstallNotification(recommendation);
		const workspace = service.promptWorkspaceRecommendations(['ASH.ACADEMY@ash']);
		const item = await added;
		await workspace;
		assert.equal(f.lookupCount, 1);
		f.notifications.model.remove(item.id);
		await file;
	});

	test('language discovery opens the same marketplace with the exact language filter', async () => {
		const f = fixture();
		using lifetime = f.lifetime;
		const added = nextNotification(f.notifications);
		const result = f.create().promptImportantExtensionsInstallNotification({
			...recommendation,
			name: 'Python',
			languageId: 'python',
			searchValue: '',
		});
		const item = await added;
		await item.actions?.primary?.find(action => action.id.endsWith('.show'))?.run();
		await result;
		assert.deepEqual(f.commands, [['ash.extensions.open', { mode: 'browse', query: '', languageId: 'python' }]]);
	});

	test('on-demand configuration suppresses automatic notifications and installation changes close old suggestions', async () => {
		const f = fixture();
		using lifetime = f.lifetime;
		await f.configuration.write('{"extensions.showRecommendationsOnlyOnDemand":true}');
		const service = f.create();
		assert.equal(await service.promptImportantExtensionsInstallNotification(recommendation), RecommendationsNotificationResult.Ignored);
		assert.equal(f.lookupCount, 0);
		await f.configuration.write('{"extensions.showRecommendationsOnlyOnDemand":false}');
		const added = nextNotification(f.notifications);
		const result = service.promptImportantExtensionsInstallNotification(recommendation);
		await added;
		f.installedChanged.fire();
		assert.equal(await result, RecommendationsNotificationResult.Cancelled);
	});

	test('installation changes during a registry lookup discard the stale result', async () => {
		const lookup = new DeferredPromise<void>();
		const f = fixture({ lookup });
		using lifetime = f.lifetime;
		const service = f.create();
		const result = service.promptImportantExtensionsInstallNotification(recommendation);
		// The catalog boundary is held, so no candidate may be published before invalidation.
		while (!f.lookupCount) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		f.installedChanged.fire();
		await lookup.complete();
		assert.equal(await result, RecommendationsNotificationResult.Ignored);
		assert.equal(f.notifications.model.getNotifications().length, 0);
	});

	test('retiring an editor context cancels both in-flight and visible suggestions', async () => {
		const lookup = new DeferredPromise<void>();
		const f = fixture({ lookup });
		using lifetime = f.lifetime;
		const service = f.create();
		const old = new AbortController();
		const pending = service.promptImportantExtensionsInstallNotification({ ...recommendation, signal: old.signal });
		while (!f.lookupCount) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		old.abort();
		await lookup.complete();
		assert.equal(await pending, RecommendationsNotificationResult.Ignored);
		assert.equal(f.notifications.model.getNotifications().length, 0);
		const current = new AbortController();
		const added = nextNotification(f.notifications);
		const visible = service.promptImportantExtensionsInstallNotification({
			...recommendation,
			signal: current.signal,
		});
		await added;
		current.abort();
		assert.equal(await visible, RecommendationsNotificationResult.Cancelled);
		assert.equal(f.notifications.model.getNotifications().length, 0);
		const replacementAdded = nextNotification(f.notifications);
		const replacement = service.promptImportantExtensionsInstallNotification(recommendation);
		const item = await replacementAdded;
		f.notifications.model.remove(item.id);
		assert.equal(await replacement, RecommendationsNotificationResult.Cancelled);
	});

	test('global ignores suppress notifications and undo restores eligibility', async () => {
		const f = fixture();
		using lifetime = f.lifetime;
		const service = f.create();
		f.ignored.toggleGlobalIgnoredRecommendation('ASH.ACADEMY', true);
		assert.equal(await service.promptImportantExtensionsInstallNotification(recommendation), RecommendationsNotificationResult.Ignored);
		assert.equal(f.lookupCount, 0);
		f.ignored.toggleGlobalIgnoredRecommendation('ash.academy', false);
		const added = nextNotification(f.notifications);
		const result = service.promptImportantExtensionsInstallNotification(recommendation);
		const item = await added;
		f.notifications.model.remove(item.id);
		await result;
	});

	test('multi-package notifications open Recommended rather than searching only one package name', async () => {
		const f = fixture();
		using lifetime = f.lifetime;
		const added = nextNotification(f.notifications);
		const result = f.create().promptImportantExtensionsInstallNotification({ ...recommendation, extensions: ['one@ash', 'two@ash'] });
		const item = await added;
		await item.actions?.primary?.find(action => action.id.endsWith('.show'))?.run();
		await result;
		assert.deepEqual(f.commands, [['ash.extensions.open', { query: '@recommended' }]]);
	});

	test('limits file notification volume while retaining explicit workspace recommendations', async () => {
		const f = fixture();
		using lifetime = f.lifetime;
		const service = f.create();
		for (const id of ['one@ash', 'two@ash', 'three@ash']) {
			const added = nextNotification(f.notifications);
			const result = service.promptImportantExtensionsInstallNotification({
				...recommendation,
				extensions: [id],
			});
			const item = await added;
			f.notifications.model.remove(item.id);
			await result;
		}
		assert.equal(await service.promptImportantExtensionsInstallNotification({ ...recommendation, extensions: ['four@ash'] }), RecommendationsNotificationResult.TooMany);
		const added = nextNotification(f.notifications);
		const result = service.promptWorkspaceRecommendations(['workspace@ash']);
		const item = await added;
		f.notifications.model.remove(item.id);
		await result;
	});

	test('tool suggestions allow at most one prompt and yield when two file prompts have been shown', async () => {
		const f = fixture();
		using lifetime = f.lifetime;
		const service = f.create();
		const added = nextNotification(f.notifications);
		const result = service.promptImportantExtensionsInstallNotification({
			...recommendation,
			source: RecommendationSource.EXE,
		});
		const item = await added;
		f.notifications.model.remove(item.id);
		await result;
		assert.equal(
			await service.promptImportantExtensionsInstallNotification({
				...recommendation,
				source: RecommendationSource.EXE,
				extensions: ['other@ash'],
			}),
			RecommendationsNotificationResult.TooMany,
		);
		service.resetIgnoredRecommendations();
		for (const id of ['first@ash', 'second@ash']) {
			const added = nextNotification(f.notifications);
			const result = service.promptImportantExtensionsInstallNotification({
				...recommendation,
				extensions: [id],
			});
			const item = await added;
			f.notifications.model.remove(item.id);
			await result;
		}
		assert.equal(
			await service.promptImportantExtensionsInstallNotification({
				...recommendation,
				source: RecommendationSource.EXE,
			}),
			RecommendationsNotificationResult.TooMany,
		);
	});

	test('restores dismissed notification preferences without overwriting global settings', async () => {
		const f = fixture();
		using lifetime = f.lifetime;
		const service = f.create();
		f.storage.store('extensionsAssistant/importantRecommendationsIgnore', '["ash.academy"]', StorageScope.PROFILE, StorageTarget.USER);
		f.storage.store('extensionsAssistant/workspaceRecommendationsIgnore', true, StorageScope.WORKSPACE, StorageTarget.USER);
		service.resetIgnoredRecommendations();
		assert.deepEqual(service.ignoredRecommendations, []);
		assert.equal(f.storage.getBoolean('extensionsAssistant/workspaceRecommendationsIgnore', StorageScope.WORKSPACE, false), false);
		assert.equal(service.hasToIgnoreRecommendationNotifications(), false);
	});

	test('unavailable installed state does not produce an installation suggestion', async () => {
		const f = fixture({ installedError: true });
		using lifetime = f.lifetime;
		assert.equal(await f.create().promptImportantExtensionsInstallNotification(recommendation), RecommendationsNotificationResult.Ignored);
		assert.equal(f.lookupCount, 0);
	});
});

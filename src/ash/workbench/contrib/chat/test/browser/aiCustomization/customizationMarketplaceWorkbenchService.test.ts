import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { CancellationToken, CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { IConfigurationService, type IConfigurationChangeEvent } from '../../../../../../platform/configuration/common/configuration.js';
import { CustomizationMarketplaceMediaType } from '../../../../../../platform/customizationMarketplace/common/customizationMarketplaceService.js';
import { CustomizationMarketplaceConfiguration } from '../../../../../../platform/customizationMarketplace/common/customizationMarketplaceSources.js';
import { IExtensionManagementService, type ExtensionsSearchPage, type ExtensionsSearchOptions } from '../../../../../../platform/extensionManagement/common/extensionManagementService.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { CustomizationMarketplaceWorkbenchService } from '../../../browser/aiCustomization/customizationMarketplaceWorkbenchService.js';

function fixture(read?: (query: string, options: ExtensionsSearchOptions) => Promise<ExtensionsSearchPage>) {
	const lifetime = new DisposableStore();
	const services = lifetime.add(new InstantiationService());
	const configurationChanged = lifetime.add(new Emitter<IConfigurationChangeEvent>());
	let enabled = true;
	const requests: unknown[] = [];
	const summary = { id: 'review@ash', displayName: 'Review', description: 'Review changes', version: '1.0.0', packageType: 'plugin' };
	const configuration = {
		getValue: () => enabled,
		onDidChangeConfiguration: configurationChanged.event,
	} as unknown as IConfigurationService;
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IExtensionManagementService, {
		onDidChangeInstalled: Event.None,
		sources: async () => ({ revision: 1, sources: [{ id: 'ash', kind: 'ash', enabled: true }, { id: 'offline', kind: 'ash', enabled: true }, { id: 'open-vsx', kind: 'openVsx', enabled: true }] }),
		get: async () => ({ capabilities: [{ kind: 'skill' }, { kind: 'mcp' }] }),
		searchPage: async (query: string, options: ExtensionsSearchOptions & { sourceId: string; }) => {
			requests.push([query, options]);
			if (options.sourceId === 'offline') { throw new Error('Source is unavailable'); }
			return read ? read(query, options) : { packages: [summary], total: 1 };
		},
	} as unknown as IExtensionManagementService);
	const service = lifetime.add(services.createInstance(CustomizationMarketplaceWorkbenchService));
	return {
		service, requests, summary,
		setEnabled(value: boolean) {
			enabled = value;
			configurationChanged.fire({
				source: 1, affectedKeys: new Set([CustomizationMarketplaceConfiguration.MarketplaceEnabled]),
				change: { keys: [CustomizationMarketplaceConfiguration.MarketplaceEnabled], overrides: [] },
				affectsConfiguration: key => key === CustomizationMarketplaceConfiguration.MarketplaceEnabled,
			});
		},
		[Symbol.dispose]() { lifetime.dispose(); },
	};
}

suite('Customization marketplace backend catalog', () => {
	test('DI requires its existing package and configuration owners', () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(CustomizationMarketplaceWorkbenchService), /extensionManagementService/);
	});

	test('skill discovery uses the capability filter and retains source failures and exact installation identity', async () => {
		using owner = fixture();
		const page = await owner.service.query({ query: ' review ', mediaType: CustomizationMarketplaceMediaType.Skill, pageSize: 200 }, CancellationToken.None);
		assert.deepEqual(owner.requests, ['ash', 'offline'].map(sourceId => ['review', { sourceId, capabilityKind: 'skill', pageSize: 100, cursor: undefined }]));
		assert.deepEqual(page.items, [{
			sourceId: 'ash', identifier: owner.summary.id, displayName: 'Review', description: 'Review changes', version: '1.0.0',
			mediaType: CustomizationMarketplaceMediaType.Skill, capabilities: ['skill', 'mcp'],
			installation: { kind: 'providerCatalog', resourceKind: 'skill', selectionId: owner.summary.id },
		}]);
		assert.deepEqual(page.sourceErrors?.map(error => error.sourceId), ['offline']);
	});

	test('MCP queries use the backend MCP filter; an untyped query combines package identities once', async () => {
		using owner = fixture();
		const mcp = await owner.service.query({ mediaType: CustomizationMarketplaceMediaType.McpServer }, CancellationToken.None);
		assert.equal(mcp.items[0].installation.resourceKind, 'mcp');
		assert.deepEqual(owner.requests, ['ash', 'offline'].map(sourceId => ['', { sourceId, capabilityKind: 'mcp', pageSize: 30, cursor: undefined }]));
		const combined = await owner.service.query({}, CancellationToken.None);
		assert.equal(combined.items.length, 1);
		assert.equal(combined.sourceErrors?.length, 1);
	});

	test('disabled discovery and an empty source selection never query the registry', async () => {
		using owner = fixture();
		assert.deepEqual((await owner.service.query({ sourceIds: [] }, CancellationToken.None)).items, []);
		owner.setEnabled(false);
		assert.equal(owner.service.sources.length, 0);
		assert.equal(owner.service.allSources.length, 2);
		assert.deepEqual(await owner.service.query({}, CancellationToken.None), { items: [] });
		assert.deepEqual(owner.requests, []);
	});

	test('invalid query bounds or source selections fail before requesting the registry', async () => {
		using owner = fixture();
		for (const options of [{ pageSize: 0 }, { pageSize: 1.5 }, { query: 'x'.repeat(4097) }, { sourceIds: ['unknown'] }, { sourceIds: ['extensions', 'extensions'] }]) {
			await assert.rejects(owner.service.query(options, CancellationToken.None), /invalid/);
		}
		await assert.rejects(owner.service.query({}, CancellationToken.Cancelled), isCancellationError);
		assert.deepEqual(owner.requests, []);
	});

	for (const cause of ['token', 'configuration', 'disposal'] as const) {
		test(`${cause} retires a query while the existing catalog read is still pending`, async () => {
			let finish!: (value: ExtensionsSearchPage) => void;
			let begin!: () => void;
			const started = new Promise<void>(resolve => { begin = resolve; });
			using owner = fixture(() => new Promise(resolve => { finish = resolve; begin(); }));
			using token = new CancellationTokenSource();
			const pending = owner.service.query({ mediaType: CustomizationMarketplaceMediaType.Skill }, token.token);
			const rejection = assert.rejects(pending, isCancellationError);
			await started;
			if (cause === 'token') { token.cancel(); }
			else if (cause === 'configuration') { owner.setEnabled(false); }
			else { owner.service.dispose(); }
			await rejection;
			finish({ packages: [], total: 0 });
		});
	}
});

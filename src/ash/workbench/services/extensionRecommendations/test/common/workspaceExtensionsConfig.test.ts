import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileNotFoundError, type IFileChangeEvent } from '../../../../../platform/files/common/files.js';
import { UriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentityService.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { MemoryFileService, MemoryResourceStore, TestEditorService } from '../../../../contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { TestConfigurationService, TestWorkspaceService } from '../../../configuration/test/common/testServices.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ModelService } from '../../../../../editor/common/services/modelService.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../../../../editor/common/services/languageFeaturesService.js';
import { ILanguageServerService, type LanguageServerSnapshot } from '../../../../../platform/language/common/languageServerService.js';
import { IWorkspaceExtensionsConfigService, WorkspaceExtensionsConfigService } from '../../common/workspaceExtensionsConfig.js';
import { ExtensionRecommendationsService } from '../../../../contrib/extensions/browser/extensionRecommendationsService.js';
import { ExtensionRecommendationReason, IExtensionIgnoredRecommendationsService } from '../../common/extensionRecommendations.js';
import { ExtensionIgnoredRecommendationsService } from '../../common/extensionIgnoredRecommendationsService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../storage/browser/storageService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { LanguageService } from '../../../../../editor/common/services/languageService.js';
import { IEditorService } from '../../../editor/common/editorService.js';
import { IFileTextModelService } from '../../../textmodelResolver/common/textModelResourceService.js';
import { BrowserTextModelService } from '../../../textmodelResolver/browser/browserTextModelService.js';
import { IExtensionService } from '../../../extensions/common/extensionService.js';
import {
	IExtensionManagementService,
	type ExtensionsCapabilityKind,
	type ExtensionsPackageDetails,
	type ExtensionsPackageSummary,
	type ExtensionsSearchOptions,
} from '../../../../../platform/extensionManagement/common/extensionManagementService.js';
import { RecommendationSource } from '../../../../../platform/extensionRecommendations/common/extensionRecommendations.js';
import { ExtensionUiTarget } from '../../../../../platform/extensionManagement/common/extensionManagementService.js';

import { IAppServerRemoteAgentService } from '../../../remote/common/appServerRemoteAgentService.js';

type MemoryFileBytes = Awaited<ReturnType<MemoryFileService['readFile']>>;

class RecommendationsFileProvider extends MemoryFileService {
	public override readonly onDidChangeFiles;
	public watches = 0;
	public error: Error | undefined;
	public heldRead: DeferredPromise<MemoryFileBytes> | undefined;
	constructor(
		private readonly changes: Emitter<IFileChangeEvent>,
		resources: readonly (readonly [URI, string])[],
	) {
		super(resources);
		this.onDidChangeFiles = changes.event;
	}
	public override watch(): IDisposable {
		++this.watches;
		return toDisposable(() => {
			--this.watches;
		});
	}
	public override async readFile(resource: URI): Promise<MemoryFileBytes> {
		if (this.heldRead) {
			const held = this.heldRead;
			this.heldRead = undefined;
			return held.p;
		}
		if (this.error) {
			throw this.error;
		}
		if (!this.has(resource)) {
			throw new FileNotFoundError(resource);
		}
		return super.readFile(resource);
	}
	public invalidate(resource: URI): void {
		this.changes.fire({ resources: [resource] });
	}
}

function fixture(resources: readonly (readonly [URI, string])[] = [], target = ExtensionUiTarget.IDE) {
	const lifetime = new DisposableStore();
	const workspace = lifetime.add(new TestWorkspaceService({ id: 'project', uri: URI.file('/project') }));
	const files = lifetime.add(new FileService());
	const changes = lifetime.add(new Emitter<IFileChangeEvent>());
	const provider = new RecommendationsFileProvider(changes, resources);
	lifetime.add(files.registerProvider('file', provider));
	const identity = lifetime.add(new UriIdentityService(files));
	const configs = lifetime.add(new WorkspaceExtensionsConfigService(workspace, files, identity));
	const services = lifetime.add(new InstantiationService());
	const browser = new JSDOM('', { url: 'https://recommendations.test' });
	lifetime.add(toDisposable(() => browser.window.close()));
	const storage = lifetime.add(
		new BrowserStorageService({
			ownerWindow: browser.window as unknown as Window,
			workspaceId: 'project',
			backend: browser.window.localStorage,
			flushInterval: 0,
		}),
	);
	services.registerInstance(IStorageService, storage);
	const languages = lifetime.add(new LanguageService());
	const languageFeatures = lifetime.add(new LanguageFeaturesService());
	services.registerInstance(ILanguageFeaturesService, languageFeatures);
	const serverLanguages = new Map<string | undefined, LanguageServerSnapshot['servers']>();
	services.registerInstance(ILanguageServerService, {
		read: async dirId => ({ revision: 0, configurations: {}, servers: serverLanguages.get(dirId) ?? [] }),
	} as ILanguageServerService);
	lifetime.add(languages.registerLanguage({ id: 'python', extensions: ['.py'], aliases: ['Python'] }));
	lifetime.add(languages.registerLanguage({ id: 'rust', extensions: ['.rs'], aliases: ['Rust'] }));
	const store = lifetime.add(new MemoryResourceStore(resources));
	services.registerInstance(IUriIdentityService, identity);
	const models = lifetime.add(services.createInstance(BrowserTextModelService, store, { languageService: languages }));
	const editorModels = lifetime.add(new ModelService(lifetime.add(new TestConfigurationService()), { _serviceBrand: undefined, getEOL: () => '\n' }, languages));
	const installedChanged = lifetime.add(new Emitter<void>());
	let installed: string[] = [];
	let environment: Awaited<ReturnType<IExtensionManagementService['recommendationEnvironment']>> = {
		platform: 'other',
		executables: [],
	};
	let productIds: readonly string[] = [];
	const packageDetails = new Map<string, ExtensionsPackageDetails>([
		[
			'ash.academy@ash',
			{
				package: { id: 'ash.academy@ash', version: '1', digest: '' },
				packageType: 'editor',
				displayName: 'Docs',
				description: '',
				license: '',
				source: 'official',
				upstream: null,
				capabilities: [],
				uiTargets: [ExtensionUiTarget.IDE, ExtensionUiTarget.Agents],
			},
		],
	]);
	let environmentReads = 0;
	let connection: IAppServerRemoteAgentService['connection'];
	const connectionChanged = lifetime.add(new Emitter<void>());
	services.registerInstance(IAppServerRemoteAgentService, {
		onDidChangeConnection: connectionChanged.event,
		onDidChangeConnectionState: Event.None,
		get connection() {
			return connection;
		},
	} as unknown as IAppServerRemoteAgentService);
	let search: (query: string, options?: ExtensionsSearchOptions) => Promise<readonly ExtensionsPackageSummary[]> = async (_query, options) =>
		options?.languageId || _query === '.yaml'
			? [
					{
						id: `support.${options?.languageId ?? 'yaml'}@ash`,
						version: '1',
						packageType: 'language',
						displayName: options?.languageId ?? 'YAML',
						description: '',
						uiTargets: [ExtensionUiTarget.IDE, ExtensionUiTarget.Agents],
					},
				]
			: [];
	const queries: { query: string; options?: ExtensionsSearchOptions }[] = [];
	services.registerInstance(IWorkspaceExtensionsConfigService, configs);
	const ignored = lifetime.add(services.createInstance(ExtensionIgnoredRecommendationsService));
	services.registerInstance(IExtensionIgnoredRecommendationsService, ignored);
	services.registerInstance(IFileTextModelService, models);
	services.registerInstance(IModelService, editorModels);
	let visibleResources: readonly URI[] = [];
	const visibleEditorsChanged = lifetime.add(new Emitter<void>());
	const editors = new TestEditorService();
	Object.defineProperty(editors, 'visibleEditors', { get: () => visibleResources.map(resource => ({ resource })) });
	Object.defineProperty(editors, 'onDidVisibleEditorsChange', { value: visibleEditorsChanged.event });
	services.registerInstance(IEditorService, editors);
	services.registerInstance(ILanguageService, languages);
	services.registerInstance(IWorkspaceContextService, workspace);
	services.registerInstance(IFileService, files);
	services.registerInstance(IExtensionManagementService, {
		onDidChangeInstalled: installedChanged.event,
		recommendationEnvironment: async () => {
			++environmentReads;
			return environment;
		},
		get: async (id: string) => {
			if (packageDetails.has(id)) {
				return packageDetails.get(id)!;
			}
			if (!productIds.includes(id)) {
				throw new Error('Product package is unavailable');
			}
			return { package: { id }, displayName: id, uiTargets: [ExtensionUiTarget.IDE] };
		},
		listInstalled: async () => installed.map(id => ({ package: { id } })),
		search: async (query: string, options?: ExtensionsSearchOptions) => {
			queries.push({ query, options });
			return search(query, options);
		},
	} as unknown as IExtensionManagementService);
	services.registerInstance(IExtensionService, {
		onDidChange: Event.None,
		currentCatalog: { extensions: [], generation: 1, diagnostics: [] },
	} as unknown as IExtensionService);
	const recommendations = lifetime.add(services.createInstance(ExtensionRecommendationsService, target));
	return {
		lifetime,
		workspace,
		files,
		provider,
		configs,
		recommendations,
		models,
		editorModels,
		languages,
		languageFeatures,
		queries,
		installedChanged,
		services,
		storage,
		ignored,
		get environmentReads() {
			return environmentReads;
		},
		setVisibleResources: (resources: readonly URI[]) => {
			visibleResources = resources;
			visibleEditorsChanged.fire();
		},
		setPackage: (id: string, kinds: readonly ExtensionsCapabilityKind[], uiTargets?: readonly ExtensionUiTarget[]) => {
			packageDetails.set(id, {
				package: { id, version: '1', digest: '' },
				packageType: 'plugin',
				displayName: id,
				description: '',
				license: '',
				source: 'official',
				upstream: null,
				uiTargets,
				capabilities: kinds.map(kind => ({
					kind,
					id: kind,
					contractVersion: '1',
					permissions: [],
					authenticationProvider: null,
				})),
			});
			recommendations.refresh();
		},
		setProductIds: (ids: readonly string[]) => {
			productIds = ids;
			recommendations.refresh();
		},
		setEnvironment: (value: typeof environment) => {
			environment = value;
			recommendations.refresh();
		},
		setConnection: (value: typeof connection) => {
			connection = value;
			connectionChanged.fire();
		},
		setInstalled: (ids: string[]) => {
			installed = ids;
			installedChanged.fire();
		},
		setSearch: (value: typeof search) => {
			search = value;
		},
		setServerLanguages: (languages: readonly string[], dirId?: string) => {
			serverLanguages.set(dirId, [{ id: 'builtin', languageIds: languages }]);
			recommendations.refresh();
		},
	};
}

suite('Workspace extension recommendations', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('manifest audiences filter declarations while mixed packages share installation and ignore state', async () => {
		const f = fixture([
			[
				URI.file('/project/.ash/extensions.json'),
				JSON.stringify({
					recommendations: ['editor/tool', 'agent/tool', 'mixed/tool', 'theme/tool', 'unknown/tool'],
				}),
			],
		]);
		using lifetime = f.lifetime;
		f.setPackage('editor/tool', ['editorExtension'], [ExtensionUiTarget.IDE]);
		f.setPackage('agent/tool', ['skill', 'connector'], [ExtensionUiTarget.Agents]);
		f.setPackage('mixed/tool', ['language', 'mcp'], [ExtensionUiTarget.IDE, ExtensionUiTarget.Agents]);
		f.setPackage('theme/tool', ['theme'], [ExtensionUiTarget.IDE, ExtensionUiTarget.Agents]);
		f.setPackage('unknown/tool', ['theme', 'skill']);
		const agents = lifetime.add(f.services.createInstance(ExtensionRecommendationsService, ExtensionUiTarget.Agents));
		const ids = async (service: ExtensionRecommendationsService) => (await service.getRecommendations()).recommendations.map(item => item.extensionId);
		assert.deepEqual(await ids(f.recommendations), ['editor/tool', 'mixed/tool', 'theme/tool', 'unknown/tool']);
		assert.deepEqual(await ids(agents), ['agent/tool', 'mixed/tool', 'theme/tool', 'unknown/tool']);
		const snapshot = await agents.getRecommendations();
		assert.deepEqual(snapshot.recommendations.find(item => item.extensionId === 'mixed/tool')!.uiTargets, [ExtensionUiTarget.IDE, ExtensionUiTarget.Agents]);
		assert.equal(snapshot.recommendations.find(item => item.extensionId === 'unknown/tool')!.context, undefined);
		assert.equal(snapshot.recommendations.find(item => item.extensionId === 'unknown/tool')!.uiTargets, undefined);
		f.ignored.toggleGlobalIgnoredRecommendation('mixed/tool', true);
		f.setInstalled(['theme/tool']);
		assert.deepEqual(await ids(f.recommendations), ['editor/tool', 'unknown/tool']);
		assert.deepEqual(await ids(agents), ['agent/tool', 'unknown/tool']);
	});

	test('Agents do not infer editor recommendations from host tools, project files, background models or IDE history', async () => {
		const f = fixture([[URI.file('/project/pyproject.toml'), '[project]']], ExtensionUiTarget.Agents);
		using lifetime = f.lifetime;
		f.setProductIds(['marketplace.python@ash', 'marketplace.keymap-sublime@ash']);
		f.setEnvironment({ platform: 'linux', executables: ['python3'] });
		f.storage.store('extensionsAssistant/recentRecommendations', JSON.stringify({ 'marketplace.python@ash': Date.now() }), StorageScope.PROFILE, StorageTarget.MACHINE);
		lifetime.add(f.editorModels.createModel('', f.languages.createById('python'), URI.file('/project/background.py')));
		assert.deepEqual((await f.recommendations.getRecommendations()).recommendations, []);
		assert.deepEqual(f.queries, []);
		assert.equal(f.environmentReads, 0);
	});

	test('manifest audiences take precedence over technical capabilities and recommendation identities', async () => {
		const f = fixture([[URI.file('/project/.ash/extensions.json'), '{"recommendations":["marketplace.python@ash"]}']], ExtensionUiTarget.Agents);
		using lifetime = f.lifetime;
		f.setPackage('marketplace.python@ash', ['language', 'skill'], [ExtensionUiTarget.IDE]);
		assert.deepEqual((await f.recommendations.getRecommendations()).recommendations, []);
		f.setPackage('marketplace.python@ash', ['language'], [ExtensionUiTarget.Agents]);
		const recommendation = (await f.recommendations.getRecommendations()).recommendations[0]!;
		assert.deepEqual(recommendation.uiTargets, [ExtensionUiTarget.Agents]);
		assert.equal(recommendation.context?.source, RecommendationSource.WORKSPACE);
	});

	test('an actual Python editor in Agents establishes a shared editing context and closing it retires the prompt', async () => {
		const f = fixture([], ExtensionUiTarget.Agents);
		using lifetime = f.lifetime;
		const resource = URI.file('/project/main.py');
		f.setProductIds(['marketplace.python@ash']);
		f.setPackage('marketplace.python@ash', ['language'], [ExtensionUiTarget.IDE, ExtensionUiTarget.Agents]);
		f.setSearch(async () => [
			{
				id: 'marketplace.python@ash',
				version: '1',
				packageType: 'language',
				displayName: 'Python',
				description: '',
				uiTargets: [ExtensionUiTarget.IDE, ExtensionUiTarget.Agents],
			},
		]);
		lifetime.add(f.editorModels.createModel('', f.languages.createById('python'), resource));
		assert.deepEqual((await f.recommendations.getRecommendations()).recommendations, []);
		f.setVisibleResources([resource]);
		const python = (await f.recommendations.getRecommendations()).recommendations[0]!;
		assert.equal(python.extensionId, 'marketplace.python@ash');
		assert.deepEqual(python.uiTargets, [ExtensionUiTarget.IDE, ExtensionUiTarget.Agents]);
		assert.equal(python.context?.source, RecommendationSource.FILE);
		f.setVisibleResources([]);
		assert.ok((await f.recommendations.getRecommendations()).recommendations.every(item => !item.context));
	});

	test('shared editor intents keep their audience and recent history within the initiating window', async () => {
		const f = fixture([], ExtensionUiTarget.Agents);
		using lifetime = f.lifetime;
		f.recommendations.recommendForResource(URI.parse('untitled:/document.ash-doc'));
		const recommendation = (await f.recommendations.getRecommendations()).recommendations[0]!;
		assert.equal(recommendation.extensionId, 'ash.academy@ash');
		assert.deepEqual(recommendation.uiTargets, [ExtensionUiTarget.IDE, ExtensionUiTarget.Agents]);
		const reopened = lifetime.add(f.services.createInstance(ExtensionRecommendationsService, ExtensionUiTarget.Agents));
		assert.equal((await reopened.getRecommendations()).recommendations[0]!.extensionId, 'ash.academy@ash');
		const ide = lifetime.add(f.services.createInstance(ExtensionRecommendationsService, ExtensionUiTarget.IDE));
		assert.deepEqual((await ide.getRecommendations()).recommendations, []);
	});

	test('project evidence takes precedence over a host-tool recommendation for the same package', async () => {
		const f = fixture([[URI.file('/project/pyproject.toml'), '[project]']]);
		using lifetime = f.lifetime;
		f.setProductIds(['marketplace.python@ash']);
		f.setEnvironment({ platform: 'linux', executables: ['python3'] });
		f.setSearch(async () => [
			{
				id: 'marketplace.python@ash',
				version: '1',
				packageType: 'language',
				displayName: 'Python',
				description: '',
				uiTargets: [ExtensionUiTarget.IDE, ExtensionUiTarget.Agents],
			},
		]);
		const python = (await f.recommendations.getRecommendations()).recommendations[0]!;
		assert.equal(python.reason.reasonId, ExtensionRecommendationReason.WorkspaceConfig);
		assert.equal(python.context?.source, RecommendationSource.WORKSPACE);
	});
	test('product tips stay on demand and share installed and ignored filtering', async () => {
		const f = fixture();
		using lifetime = f.lifetime;
		f.setProductIds(['marketplace.keymap-sublime@ash', 'marketplace.python@ash']);
		f.setEnvironment({ platform: 'linux', executables: ['python3'] });
		let snapshot = await f.recommendations.getRecommendations();
		assert.deepEqual(snapshot.recommendations.map(item => item.extensionId).sort(), ['marketplace.keymap-sublime@ash', 'marketplace.python@ash']);
		assert.equal(snapshot.recommendations.find(item => item.extensionId.includes('python'))?.context, undefined, 'host tools alone do not establish an editing context');
		assert.equal(snapshot.recommendations.find(item => item.extensionId.includes('keymap'))?.context, undefined, 'keymaps are offered on demand');
		f.ignored.toggleGlobalIgnoredRecommendation('MARKETPLACE.PYTHON', true);
		f.setInstalled(['marketplace.keymap-sublime@ash']);
		assert.deepEqual((await f.recommendations.getRecommendations()).recommendations, []);
	});

	test('host tools stay quiet across workspace changes and service recreation while Python files still prompt', async () => {
		const f = fixture();
		using lifetime = f.lifetime;
		f.setProductIds(['marketplace.python@ash', 'marketplace.typescript@ash', 'marketplace.go@ash']);
		f.setEnvironment({ platform: 'linux', executables: ['python3', 'node', 'go'] });
		const assertOnDemand = async (service: ExtensionRecommendationsService): Promise<void> => {
			const snapshot = await service.getRecommendations();
			assert.deepEqual(
				snapshot.recommendations.map(item => item.extensionId).sort(),
				['marketplace.go@ash', 'marketplace.python@ash'],
				'Node availability must not recommend the bundled TypeScript assets',
			);
			assert.ok(snapshot.recommendations.every(item => !item.context));
			assert.ok(snapshot.recommendations.every(item => item.reason.reasonId === ExtensionRecommendationReason.Executable));
		};
		await assertOnDemand(f.recommendations);
		f.workspace.updateWorkspace({
			id: 'other',
			folders: [{ id: 'other', name: 'Other', uri: URI.file('/other'), index: 0 }],
		});
		await assertOnDemand(f.recommendations);
		await assertOnDemand(lifetime.add(f.services.createInstance(ExtensionRecommendationsService, ExtensionUiTarget.IDE)));
		f.setSearch(async () => [
			{
				id: 'marketplace.python@ash',
				version: '1',
				packageType: 'language',
				displayName: 'Python',
				description: '',
				uiTargets: [ExtensionUiTarget.IDE, ExtensionUiTarget.Agents],
			},
		]);
		const model = lifetime.add(f.editorModels.createModel('', f.languages.createById('python'), URI.file('/other/main.py')));
		const python = (await f.recommendations.getRecommendations()).recommendations.find(item => item.extensionId === 'marketplace.python@ash')!;
		assert.equal(python.context?.source, RecommendationSource.FILE);
		assert.equal(python.context?.name, 'Python');
		model.dispose();
		await assertOnDemand(f.recommendations);
	});

	test('remote authority changes refresh remote tips and keep executable suggestions quiet', async () => {
		const f = fixture();
		using lifetime = f.lifetime;
		f.setProductIds(['marketplace.remote-workspace@ash', 'marketplace.python@ash']);
		f.setEnvironment({ platform: 'linux', executables: ['python'] });
		assert.equal((await f.recommendations.getRecommendations()).recommendations.length, 1);
		f.setConnection({ kind: 'ssh', generation: 2 } as NonNullable<IAppServerRemoteAgentService['connection']>);
		const snapshot = await f.recommendations.getRecommendations();
		assert.ok(snapshot.recommendations.some(item => item.extensionId === 'marketplace.remote-workspace@ash'));
		const python = snapshot.recommendations.find(item => item.extensionId.includes('python'))!;
		assert.equal(python.reason.reasonId, ExtensionRecommendationReason.Executable);
		assert.equal(python.context, undefined, 'remote tool discovery cannot create a local installation prompt');
		f.setConnection(undefined);
		assert.ok(!(await f.recommendations.getRecommendations()).recommendations.some(item => item.extensionId === 'marketplace.remote-workspace@ash'));
	});

	test('merges Ash JSONC and multi-root workspace declarations, normalizes IDs and applies exclusions', async () => {
		const resource = URI.file('/project/.ash/extensions.json');
		const workspaceFile = URI.file('/project.ash-workspace');
		const other = URI.file('/other/.ash/extensions.json');
		const f = fixture([
			[resource, '{ // folder recommendations\n "recommendations": ["Publisher.Sample", "example/web", "example/web",], "unwantedRecommendations": ["excluded.tool"] }'],
			[workspaceFile, '{ "folders": [], "extensions": { "recommendations": ["excluded.tool", "workspace.tool"] } }'],
			[other, '{ "recommendations": ["publisher.sample", "other/tool"], "unwantedRecommendations": ["workspace.tool"] }'],
			[URI.file('/project/.vscode/extensions.json'), '{ "recommendations": ["vscode.only"] }'],
		]);
		using lifetime = f.lifetime;
		f.workspace.updateWorkspace({
			id: 'multi',
			configuration: workspaceFile,
			folders: [
				{ id: 'project', name: 'Project', uri: URI.file('/project'), index: 0 },
				{ id: 'other', name: 'Other', uri: URI.file('/other'), index: 1 },
			],
		});
		const snapshot = await f.recommendations.getWorkspaceRecommendations();
		assert.deepEqual(snapshot, {
			recommendations: ['publisher.sample', 'example/web', 'other/tool'].map(extensionId => ({
				extensionId,
				reason: {
					reasonId: ExtensionRecommendationReason.Workspace,
					reasonText: 'Recommended by this workspace',
				},
			})),
			resources: [workspaceFile, resource, other],
			diagnostics: [],
		});
		assert.equal(f.provider.watches, 5);
	});

	test('invalid external edits report diagnostics while retaining the last valid declaration; deletion clears it', async () => {
		const resource = URI.file('/project/.ash/extensions.json');
		const f = fixture([[resource, '{"recommendations":["example/web"]}']]);
		using lifetime = f.lifetime;
		assert.equal((await f.recommendations.getWorkspaceRecommendations()).recommendations.length, 1);
		for (const content of ['{', '{"recommendations":"example/web"}', '{"recommendations":[12]}', '{"unwantedRecommendations":["https://unsafe"]}']) {
			await f.files.writeFile({ resource, content });
			f.provider.invalidate(resource);
			const snapshot = await f.recommendations.getWorkspaceRecommendations();
			assert.deepEqual(
				snapshot.recommendations.map(item => item.extensionId),
				['example/web'],
			);
			assert.equal(snapshot.diagnostics.length, 1);
			assert.ok(snapshot.diagnostics[0]!.includes(resource.toString()));
		}
		await f.files.delete(resource, 'error', 'fileOrEmptyDirectory');
		f.provider.invalidate(resource);
		assert.deepEqual((await f.recommendations.getWorkspaceRecommendations()).recommendations, []);
		assert.deepEqual((await f.recommendations.getWorkspaceRecommendations()).diagnostics, []);
	});

	test('provider errors retain declarations and refresh retries instead of treating errors as missing files', async () => {
		const resource = URI.file('/project/.ash/extensions.json');
		const f = fixture([[resource, '{"recommendations":["example/web"]}']]);
		using lifetime = f.lifetime;
		await f.configs.getExtensionsConfigs();
		f.provider.error = new Error('Permission denied');
		f.provider.invalidate(resource);
		assert.match((await f.recommendations.getWorkspaceRecommendations()).diagnostics[0]!, /Permission denied/u);
		f.provider.error = undefined;
		f.recommendations.refresh();
		assert.deepEqual((await f.recommendations.getWorkspaceRecommendations()).diagnostics, []);
	});

	test('workspace replacement disposes watches and rejects a pending result from the old workspace', async () => {
		const resource = URI.file('/project/.ash/extensions.json');
		const f = fixture([[resource, '{"recommendations":["example/web"]}']]);
		using lifetime = f.lifetime;
		await f.configs.getExtensionsConfigs();
		const held = new DeferredPromise<MemoryFileBytes>();
		f.provider.heldRead = held;
		f.recommendations.refresh();
		const old = f.recommendations.getWorkspaceRecommendations();
		const rejected = assert.rejects(old, CancellationError);
		f.workspace.updateWorkspace({ id: 'empty', folders: [] });
		assert.equal(f.provider.watches, 0);
		await held.complete({
			resource,
			bytes: new TextEncoder().encode('{"recommendations":["old/tool"]}'),
			revision: 'old',
		});
		await rejected;
		assert.deepEqual(await f.recommendations.getWorkspaceRecommendations(), {
			recommendations: [],
			resources: [],
			diagnostics: [],
		});
	});

	test('file types, explicit Docs intents and model language changes share discovery and exclude internal models', async () => {
		const f = fixture();
		using lifetime = f.lifetime;
		const signal = new AbortController().signal;
		const reference = lifetime.add(await f.models.acquire({ resource: URI.parse('untitled:/draft'), initialText: '', languageId: 'python' }, signal));
		f.recommendations.recommendForResource(URI.parse('untitled:/document.ash-doc'));
		f.recommendations.recommendForResource(URI.file('/project/settings.yaml'));
		let snapshot = await f.recommendations.getRecommendations();
		assert.deepEqual(snapshot.recommendations.map(item => item.extensionId).sort(), ['ash.academy@ash', 'support.python@ash', 'support.yaml@ash']);
		assert.equal(snapshot.recommendations.find(item => item.extensionId === 'ash.academy@ash')!.context!.name, 'Docs');
		assert.ok(f.queries.some(({ query, options }) => query === '.yaml' && options?.packageType === 'language'));
		reference.model.setLanguage('rust');
		snapshot = await f.recommendations.getRecommendations();
		assert.ok(snapshot.recommendations.some(item => item.extensionId === 'support.rust@ash'));
		assert.ok(snapshot.recommendations.filter(item => item.context).every(item => item.extensionId !== 'support.python@ash'));
		lifetime.add(await f.models.acquire({ resource: URI.parse('git:/project/old.py'), initialText: '', languageId: 'python' }, signal));
		assert.ok((await f.recommendations.getRecommendations()).recommendations.filter(item => item.context).every(item => item.extensionId !== 'support.python@ash'));
	});

	test('project configuration discovery follows file changes and workspace replacement', async () => {
		const project = URI.file('/project/Cargo.toml');
		const f = fixture([[project, '[package]']]);
		using lifetime = f.lifetime;
		let snapshot = await f.recommendations.getRecommendations();
		assert.equal(snapshot.recommendations[0]!.reason.reasonId, ExtensionRecommendationReason.WorkspaceConfig);
		assert.equal(snapshot.recommendations[0]!.context!.source, RecommendationSource.WORKSPACE);
		await f.files.delete(project, 'error', 'fileOrEmptyDirectory');
		f.provider.invalidate(project);
		assert.deepEqual((await f.recommendations.getRecommendations()).recommendations, []);
		const pythonProject = URI.file('/project/pyproject.toml');
		await f.files.writeFile({ resource: pythonProject, content: '[project]' });
		f.provider.invalidate(pythonProject);
		snapshot = await f.recommendations.getRecommendations();
		assert.deepEqual(
			snapshot.recommendations.map(item => item.extensionId),
			['support.python@ash'],
		);
		f.workspace.updateWorkspace({ id: 'empty', folders: [] });
		assert.deepEqual((await f.recommendations.getRecommendations()).recommendations, []);
		assert.equal(f.provider.watches, 0);
	});

	test('editor-owned models trigger language discovery, exclude simple widgets and release recommendations on close', async () => {
		const f = fixture();
		using lifetime = f.lifetime;
		const resource = URI.parse('untitled:/Untitled-1');
		const model = lifetime.add(f.editorModels.createModel('', f.languages.createById('plaintext'), resource));
		assert.deepEqual((await f.recommendations.getRecommendations()).recommendations, []);
		model.setLanguage('python');
		assert.deepEqual(
			(await f.recommendations.getRecommendations()).recommendations.map(item => item.extensionId),
			['support.python@ash'],
		);
		model.dispose();
		lifetime.add(f.editorModels.createModel('', f.languages.createById('python'), URI.parse('untitled:/widget'), true));
		assert.ok((await f.recommendations.getRecommendations()).recommendations.every(item => !item.context));
	});

	test('recognized languages do not recommend redundant syntax packages or metadata substring matches', async () => {
		const f = fixture();
		using lifetime = f.lifetime;
		f.setSearch(async (query, options) =>
			options?.packageType === 'language' && query === 'python'
				? [
						{
							id: 'syntax.python@ash',
							version: '1',
							packageType: 'language',
							displayName: 'Python syntax',
							description: '',
						},
					]
				: [],
		);
		lifetime.add(await f.models.acquire({ resource: URI.parse('untitled:/Untitled-1'), initialText: '', languageId: 'python' }, new AbortController().signal));
		const snapshot = await f.recommendations.getRecommendations();
		assert.deepEqual(snapshot.recommendations, []);
		assert.deepEqual(f.queries, [{ query: '', options: { languageId: 'python', capabilityKind: 'executable', limit: 5 } }]);
	});

	test('language intelligence suppresses automatic file and project suggestions and refreshes when withdrawn', async () => {
		const f = fixture([[URI.file('/project/pyproject.toml'), '[project]']]);
		using lifetime = f.lifetime;
		lifetime.add(await f.models.acquire({ resource: URI.file('/project/main.py'), initialText: '', languageId: 'python' }, new AbortController().signal));
		const provider = f.languageFeatures.hoverProvider.register('python', { provideHover: async () => undefined });
		assert.deepEqual((await f.recommendations.getRecommendations()).recommendations, []);
		assert.deepEqual(f.queries, []);
		provider.dispose();
		assert.deepEqual(
			(await f.recommendations.getRecommendations()).recommendations.map(item => item.extensionId),
			['support.python@ash'],
		);
	});

	test('enabled servers suppress installation prompts before initialization, independently for each workspace folder', async () => {
		const f = fixture([
			[URI.file('/project/pyproject.toml'), '[project]'],
			[URI.file('/other/pyproject.toml'), '[project]'],
		]);
		using lifetime = f.lifetime;
		f.setServerLanguages(['python']);
		assert.deepEqual((await f.recommendations.getRecommendations()).recommendations, []);
		f.workspace.updateWorkspace({
			id: 'multi',
			folders: [
				{ id: 'project', name: 'Project', uri: URI.file('/project'), index: 0 },
				{ id: 'other', name: 'Other', uri: URI.file('/other'), index: 1 },
			],
		});
		f.setServerLanguages(['python'], 'project');
		assert.deepEqual(
			(await f.recommendations.getRecommendations()).recommendations.map(item => item.extensionId),
			['support.python@ash'],
		);
		f.setServerLanguages(['python'], 'other');
		assert.deepEqual((await f.recommendations.getRecommendations()).recommendations, []);
	});

	test('merges all sources by package identity, honors workspace exclusions and refreshes installed state', async () => {
		const f = fixture([[URI.file('/project/.ash/extensions.json'), '{"recommendations":["SUPPORT.PYTHON@ash"],"unwantedRecommendations":["ASH.ACADEMY"]}']]);
		using lifetime = f.lifetime;
		lifetime.add(await f.models.acquire({ resource: URI.file('/project/main.py'), initialText: '', languageId: 'python' }, new AbortController().signal));
		f.recommendations.recommendForResource(URI.parse('untitled:/document.ash-doc'));
		let snapshot = await f.recommendations.getRecommendations();
		assert.deepEqual(
			snapshot.recommendations.map(item => item.extensionId),
			['support.python@ash'],
		);
		assert.equal(snapshot.recommendations[0]!.reason.reasonId, ExtensionRecommendationReason.Workspace);
		f.setInstalled(['SUPPORT.PYTHON@ash']);
		assert.deepEqual((await f.recommendations.getRecommendations()).recommendations, []);
		f.setInstalled([]);
		assert.equal((await f.recommendations.getRecommendations()).recommendations.length, 1);
	});

	test('rejects stale discovery after a language change and retries offline catalogs on refresh', async () => {
		const f = fixture();
		using lifetime = f.lifetime;
		const held = new DeferredPromise<readonly ExtensionsPackageSummary[]>();
		const started = new DeferredPromise<void>();
		f.setSearch(async () => {
			started.complete();
			return held.p;
		});
		const model = lifetime.add(await f.models.acquire({ resource: URI.parse('untitled:/draft'), initialText: '', languageId: 'python' }, new AbortController().signal));
		const pending = f.recommendations.getRecommendations();
		const rejected = assert.rejects(pending, CancellationError);
		await started.p;
		model.model.setLanguage('rust');
		await held.complete([]);
		await rejected;
		f.setSearch(async () => {
			throw new Error('offline');
		});
		assert.deepEqual((await f.recommendations.getRecommendations()).recommendations, []);
		f.setSearch(async () => [{ id: 'recovered@ash', version: '1', packageType: 'language', displayName: 'Recovered', description: '' }]);
		f.recommendations.refresh();
		assert.deepEqual(
			(await f.recommendations.getRecommendations()).recommendations.map(item => item.extensionId),
			['recovered@ash'],
		);
	});

	test('requires production dependencies instead of constructing fallback services', () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(ExtensionRecommendationsService, ExtensionUiTarget.IDE), /workspaceExtensionsConfigService/u);
	});

	test('remembers recent file recommendations across service instances without replaying automatic contexts', async () => {
		const f = fixture();
		using lifetime = f.lifetime;
		f.recommendations.recommendForResource(URI.parse('untitled:/document.ash-doc'));
		await f.recommendations.getRecommendations();
		const reopened = lifetime.add(f.services.createInstance(ExtensionRecommendationsService, ExtensionUiTarget.IDE));
		const snapshot = await reopened.getRecommendations();
		assert.deepEqual(
			snapshot.recommendations.map(item => item.extensionId),
			['ash.academy@ash'],
		);
		assert.equal(snapshot.recommendations[0]!.context, undefined);
		assert.equal(snapshot.recommendations[0]!.reason.reasonText, 'Recommended because of recently opened files');
	});

	test('expires history after seven days and discards malformed or future entries', async () => {
		const f = fixture();
		using lifetime = f.lifetime;
		const now = Date.now();
		f.storage.store(
			'extensionsAssistant/recentRecommendations',
			JSON.stringify({
				'recent@ash': now,
				'expired@ash': now - 8 * 86_400_000,
				'future@ash': now + 86_400_000,
				'wrong@ash': 'yesterday',
				'https://invalid': now,
			}),
			StorageScope.PROFILE,
			StorageTarget.MACHINE,
		);
		assert.deepEqual(
			(await f.recommendations.getRecommendations()).recommendations.map(item => item.extensionId),
			['recent@ash'],
		);
		f.storage.store('extensionsAssistant/recentRecommendations', '{broken', StorageScope.PROFILE, StorageTarget.MACHINE);
		f.recommendations.refresh();
		assert.deepEqual((await f.recommendations.getRecommendations()).recommendations, []);
	});

	test('global ignore and undo share persistent state while workspace exclusions remain authoritative', async () => {
		const f = fixture([[URI.file('/project/.ash/extensions.json'), '{"recommendations":["ash.academy@ash"],"unwantedRecommendations":["workspace.hidden"]}']]);
		using lifetime = f.lifetime;
		await f.recommendations.getRecommendations();
		f.ignored.toggleGlobalIgnoredRecommendation('ASH.ACADEMY@ash', true);
		assert.deepEqual((await f.recommendations.getRecommendations()).recommendations, []);
		const reopened = lifetime.add(f.services.createInstance(ExtensionIgnoredRecommendationsService));
		assert.deepEqual(reopened.globalIgnoredRecommendations, ['ash.academy']);
		f.ignored.toggleGlobalIgnoredRecommendation('ash.academy', false);
		assert.deepEqual(
			(await f.recommendations.getRecommendations()).recommendations.map(item => item.extensionId),
			['ash.academy@ash'],
		);
		assert.ok(f.ignored.ignoredRecommendations.includes('workspace.hidden'));
		f.storage.store('extensionsAssistant/ignored_recommendations', '{broken', StorageScope.PROFILE, StorageTarget.USER);
		assert.deepEqual(f.ignored.globalIgnoredRecommendations, []);
	});

	test('additional project formats use the same language catalog discovery', async () => {
		const f = fixture([
			[URI.file('/project/tsconfig.json'), '{}'],
			[URI.file('/project/Dockerfile'), 'FROM scratch'],
		]);
		using lifetime = f.lifetime;
		const snapshot = await f.recommendations.getRecommendations();
		assert.deepEqual(snapshot.recommendations.map(item => item.extensionId).sort(), ['support.dockerfile@ash', 'support.typescript@ash']);
		assert.ok(snapshot.recommendations.every(item => item.reason.reasonId === ExtensionRecommendationReason.WorkspaceConfig));
	});
});

import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ExtensionUiTarget } from '../../../../../platform/extensionManagement/common/extensionManagementService.js';
import type { IFileTextModelService } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { ExtensionRecommendationsService } from '../../browser/extensionRecommendationsService.js';

test('recommendations index open language support once and keep it scoped to each resource', async () => {
	const count = 128;
	let modelReads = 0;
	let providerChecks = 0;
	const searches: string[] = [];
	const models = Array.from({ length: count }, (_, index) => ({ uri: URI.file(`/workspace/file-${index}.ts`), getLanguageId: () => 'typescript' }));
	const modelEvents = { onModelAdded: Event.None, onModelRemoved: Event.None, onModelLanguageChanged: Event.None };
	const editorModels = { ...modelEvents, getModels: () => { modelReads++; return models; } };
	const fileModels = { ...modelEvents, getModels: () => { modelReads++; return []; } };
	type Services = ConstructorParameters<typeof ExtensionRecommendationsService>;
	const configs = { onDidChangeExtensionsConfigs: Event.None, getExtensionsConfigs: async () => [], refresh() { } };
	const editors = { onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, visibleEditors: [] };
	const languages = { onDidChange: Event.None, getLanguageName: () => 'TypeScript' };
	const languageFeatures = { hoverProvider: { onDidChange: Event.None, has: (model: typeof models[number]) => { providerChecks++; return model === models[0]; } } };
	const workspace = { onDidChangeWorkspace: Event.None, getWorkspace: () => ({ folders: [] }), getWorkspaceFolder: () => undefined };
	const files = { onDidChangeFileSystemProviderRegistrations: Event.None, onDidChangeFiles: Event.None };
	const packages = {
		onDidChangeInstalled: Event.None,
		listInstalled: async () => [],
		search: async (_query: string, { languageId }: { readonly languageId: string; }) => {
			searches.push(languageId);
			return [{ id: 'test.typescript', packageType: 'language', uiTargets: [ExtensionUiTarget.IDE] }];
		},
		get: async () => { throw new Error('No product recommendation in this fixture'); },
	};
	const extensions = { onDidChange: Event.None, currentCatalog: { extensions: [] } };
	const storage = { onDidChangeValue: Event.None, get: (_key: string, _scope: unknown, fallback: string) => fallback, store: () => { } };
	const ignored = { onDidChangeIgnoredRecommendations: Event.None, globalIgnoredRecommendations: [] };
	const remote = { onDidChangeConnection: Event.None, onDidChangeConnectionState: Event.None };
	using recommendations = new ExtensionRecommendationsService(ExtensionUiTarget.IDE,
		configs as Services[1], fileModels as unknown as IFileTextModelService, editorModels as unknown as Services[3],
		editors as unknown as Services[4], languages as unknown as Services[5], languageFeatures as unknown as Services[6], {} as Services[7],
		workspace as unknown as Services[8], files as unknown as Services[9], packages as unknown as Services[10],
		extensions as unknown as Services[11], storage as unknown as Services[12], ignored as unknown as Services[13],
		{ extUri } as unknown as Services[14], remote as unknown as Services[15]);

	assert.deepEqual((await recommendations.getRecommendations()).recommendations.map(entry => entry.extensionId), ['test.typescript']);
	assert.deepEqual(searches, ['typescript']);
	assert.equal(modelReads, 2);
	assert.equal(providerChecks, count);
});

import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import type { ILanguageFeaturesService } from '../../common/services/languageFeatures.js';
import { DefaultDropProvidersFeature, DefaultPasteProvidersFeature } from '../../contrib/dropOrPasteInto/browser/defaultProviders.js';
import { getCodeLensCache } from '../../contrib/codelens/browser/codeLensCache.js';
import { registerEditorContribution } from '../editorFeatureRegistration.js';

// Several views share one host registry. Default providers and cache bindings belong to that registry's live users.
const shared = new WeakMap<ILanguageFeaturesService, { users: number; resources: DisposableStore }>();
registerEditorContribution({
	id: 'editor.contrib.codeServices',
	configure: context => {
		const features = context.languageFeaturesService;
		let entry = shared.get(features);
		if (!entry) {
			const resources = new DisposableStore();
			try {
				const workspace = context.getOptionalService(IWorkspaceContextService);
				if (workspace) {
					resources.add(new DefaultPasteProvidersFeature(features, workspace));
					resources.add(new DefaultDropProvidersFeature(features, workspace));
				}
				const storage = context.getOptionalService(IStorageService);
				if (storage) resources.add(getCodeLensCache(features).bindStorage(storage));
				entry = { users: 0, resources };
				shared.set(features, entry);
			} catch (error) {
				resources.dispose();
				throw error;
			}
		}
		entry.users++;
		const lease = entry;
		context.register(
			toDisposable(() => {
				if (--lease.users === 0) {
					shared.delete(features);
					lease.resources.dispose();
				}
			}),
		);
	},
});

import { start } from '../../editor.worker.start.js';
import { LanguageCompletionCatalogWirePublisher } from '../../common/languages/completion/languageCompletionCatalogWire.js';
import { LanguageCompletionProviderRegistry } from '../../common/languages/completion/languageCompletionProviders.js';
import { LanguageCompletionProviderModuleHost, LanguageCompletionProviderModuleRegistry } from '../../common/languages/completion/languageCompletionProviderModules.js';
import { LanguageCompletionProviderModuleWireServer } from '../../common/languages/completion/languageCompletionProviderModuleWire.js';
import { LanguageCompletionResolveWireServer } from '../../common/languages/completion/languageCompletionResolveWire.js';
import { LanguageCompletionProviderWorker } from '../../common/languages/completion/languageCompletionService.js';
import { languageCompletionWireCodec } from '../../common/languages/completion/languageCompletionWire.js';
import { createLanguageWordCompletionProvider } from '../../common/languages/completion/languageWordCompletionProvider.js';
import { LanguageWorkerWireServer } from '../../common/languages/languageWorkerWire.js';

start(({ port, resources }) => {
	const registry = resources.add(new LanguageCompletionProviderRegistry());
	const modules = resources.add(new LanguageCompletionProviderModuleRegistry());
	resources.add(modules.register({
		id: 'language.word',
		load: () => [createLanguageWordCompletionProvider()],
	}));
	const moduleHost = resources.add(new LanguageCompletionProviderModuleHost(modules, registry));
	const providerWorker = new LanguageCompletionProviderWorker(registry);
	resources.add(new LanguageWorkerWireServer(
		port,
		languageCompletionWireCodec,
		providerWorker,
	));
	resources.add(new LanguageCompletionCatalogWirePublisher(port, registry));
	resources.add(new LanguageCompletionProviderModuleWireServer(port, modules, moduleHost));
	resources.add(new LanguageCompletionResolveWireServer(port, providerWorker));
});

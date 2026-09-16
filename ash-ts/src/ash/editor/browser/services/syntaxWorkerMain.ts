import { start } from '../../editor.worker.start.js';
import { SyntaxProviderModuleHost, SyntaxProviderModuleRegistry } from '../../common/languages/syntax/syntaxProviderModules.js';
import { SyntaxProviderModuleWireServer } from '../../common/languages/syntax/syntaxProviderModuleWire.js';
import { SyntaxProviderRegistry } from '../../common/languages/syntax/syntaxProviders.js';
import { SyntaxProviderWorker } from '../../common/languages/syntax/syntaxService.js';
import { syntaxWireCodec } from '../../common/languages/syntax/syntaxWire.js';
import { registerBuiltinLanguageConfigurations } from '../../common/languages/languageBuiltinConfigurations.js';
import { LanguageConfigurationService } from '../../common/languages/languageConfigurationRegistry.js';
import { createLanguageLexicalSyntaxProvider } from '../../common/languages/languageLexicalSyntaxProvider.js';
import { LanguageWorkerWireServer } from '../../common/languages/languageWorkerWire.js';
import { InMemoryConfigurationService } from '../../../platform/configuration/common/inMemoryConfigurationService.js';
import { LanguageService } from '../../common/services/languageService.js';

start(({ port, resources }) => {
	const registry = resources.add(new SyntaxProviderRegistry());
	const modules = resources.add(new SyntaxProviderModuleRegistry());
	const configurationService = resources.add(new InMemoryConfigurationService());
	const languageService = resources.add(new LanguageService());
	const languageConfigurations = resources.add(new LanguageConfigurationService(configurationService, languageService));
	resources.add(registerBuiltinLanguageConfigurations(languageConfigurations));
	resources.add(modules.register({
		id: 'language.lexical',
		load: () => [createLanguageLexicalSyntaxProvider({ languageConfigurations })],
	}));
	const moduleHost = resources.add(new SyntaxProviderModuleHost(modules, registry));
	resources.add(new LanguageWorkerWireServer(
		port,
		syntaxWireCodec,
		new SyntaxProviderWorker(registry),
	));
	resources.add(new SyntaxProviderModuleWireServer(port, modules, moduleHost));
});

import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { Range } from '../../../../../editor/common/core/range.js';
import type { LanguageDocumentSymbol } from '../../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../../../../editor/common/services/languageFeaturesService.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import '../../../../../editor/contrib/documentSymbols/browser/documentSymbols.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { BrowserTextModelService } from '../../browser/browserTextModelService.js';
import { ITextModelResourceService } from '../../common/textModelResourceService.js';
import type { TextResourceChangeEvent } from '../../common/textResourceStore.js';
import { TextModelResolverService } from '../../common/textModelResolverService.js';

test('document symbol command resolves a closed Workbench resource and releases its model', async () => {
	const resource = URI.file('/workspace/symbols.ts');
	using changes = new Emitter<TextResourceChangeEvent>();
	let resolves = 0;
	using models = new BrowserTextModelService({
		onDidChange: changes.event,
		resolve: async request => {
			resolves++;
			return { resource: request.resource, text: 'first second', revision: '1' };
		},
		save: async () => ({ revision: '1' }),
	});
	using features = new LanguageFeaturesService();
	using first = features.documentSymbolProvider.register('*', {
		provideDocumentSymbols: () => [symbol('first', 1, 6)],
	});
	using second = features.documentSymbolProvider.register('*', {
		provideDocumentSymbols: () => [symbol('second', 7, 13)],
	});
	using services = new ServiceContainer();
	services.registerInstance(ITextModelResourceService, models);
	services.registerInstance(ILanguageFeaturesService, features);
	services.registerSingleton(ITextModelService, () => services.createInstance(TextModelResolverService));
	using commands = new CommandService(services, CommandsRegistry);

	const symbols = await commands.executeCommand<readonly LanguageDocumentSymbol[]>('_executeDocumentSymbolProvider', resource);
	assert.deepEqual(symbols.map(item => item.name), ['first', 'second']);
	assert.equal(resolves, 1);
	await assert.rejects(commands.executeCommand('_executeDocumentSymbolProvider', resource.toString()), TypeError);

	using reopened = await models.acquire({ resource }, new AbortController().signal);
	assert.equal(resolves, 2);
	const reference = await services.get(ITextModelService).createModelReference(resource);
	let disposalEvents = 0;
	using disposalListener = reference.object.onWillDispose(() => disposalEvents++);
	reference.dispose();
	assert.equal(disposalEvents, 1);
	assert.equal(reference.object.isDisposed(), true);
	assert.equal(reopened.model.isDisposed(), false);
});

function symbol(name: string, startColumn: number, endColumn: number): LanguageDocumentSymbol {
	const range = new Range(1, startColumn, 1, endColumn);
	return { name, kind: 'function', range, selectionRange: range };
}

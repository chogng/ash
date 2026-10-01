import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { TextResourceEditorModel } from '../../../../common/editor/textResourceEditorModel.js';
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
	using services = new InstantiationService();
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

test('provider references share text and release it after the last editor model closes', async () => {
	using models = new BrowserTextModelService({
		onDidChange: () => ({ dispose() {}, [Symbol.dispose]() {} }),
		resolve: async request => ({ resource: request.resource, text: '', revision: '1' }),
		save: async () => ({ revision: '1' }),
	});
	using services = new InstantiationService();
	services.registerInstance(ITextModelResourceService, models);
	const resolver = services.createInstance(TextModelResolverService);
	using text = new TextModel('shared provider content', { languageId: 'typescript' });
	using provider = resolver.registerTextModelContentProvider('review', { provideTextContent: async () => text });
	using first = await resolver.createModelReference(URI.parse('review:/content'));
	using second = await resolver.createModelReference(URI.parse('review:/content'));
	assert.ok(first.object instanceof TextResourceEditorModel);
	assert.equal(first.object.textEditorModel, second.object.textEditorModel);
	assert.equal(first.object.createSnapshot().read(), 'shared provider content');
	assert.equal(first.object.getLanguageId(), 'typescript');
	assert.equal(first.object.isReadonly(), true);
	let notifications = 0;
	using listener = first.object.onWillDispose(() => {
		notifications++;
		first.dispose();
	});
	first.dispose();
	assert.equal(notifications, 1);
	assert.equal(first.object.isResolved(), false);
	assert.equal(text.isDisposed(), false);
	assert.equal(second.object.isResolved(), true);
	second.dispose();
	assert.equal(text.isDisposed(), true);
	assert.equal(second.object.isResolved(), false);
});

function symbol(name: string, startColumn: number, endColumn: number): LanguageDocumentSymbol {
	const range = new Range(1, startColumn, 1, endColumn);
	return { name, kind: 'function', range, selectionRange: range };
}

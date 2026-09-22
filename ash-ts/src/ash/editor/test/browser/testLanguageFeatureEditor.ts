import { JSDOM } from 'jsdom';
import { suiteTeardown } from 'mocha';
import { TextModel } from '../../common/model/textModel.js';
import { LanguageFeaturesService } from '../../common/services/languageFeaturesService.js';
import type { LanguageLocation } from '../../common/languages.js';

const environment = new JSDOM('<!doctype html><body></body>');
environment.window.HTMLCanvasElement.prototype.getContext = () => null;
for (const [name, value] of Object.entries({
	window: environment.window, document: environment.window.document,
	Node: environment.window.Node, Element: environment.window.Element, HTMLElement: environment.window.HTMLElement,
	ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} },
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}
const { createTestCodeEditor } = await import('./testCodeEditor.js');
suiteTeardown(() => environment.window.close());

export function createLanguageFeatureEditor() {
	const container = environment.window.document.createElement('main');
	environment.window.document.body.append(container);
	const model = new TextModel('function root() {}', { languageId: 'typescript' });
	const features = new LanguageFeaturesService();
	const opened: LanguageLocation[] = [];
	const errors: unknown[] = [];
	const editor = createTestCodeEditor({
		container, model, languageId: 'typescript', input: { resource: model.uri },
		languageFeaturesService: features, dimension: { width: 500, height: 200 },
		onOpenLocation: location => { opened.push(location); }, onLanguageError: error => errors.push(error),
	});
	return {
		container, model, features, editor, opened, errors,
		[Symbol.dispose]: () => { editor.dispose(); features.dispose(); model.dispose(); container.remove(); },
	};
}

export async function flushLanguageRequests(): Promise<void> {
	for (let count = 0; count < 10; count++) await Promise.resolve();
}

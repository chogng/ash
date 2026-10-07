import '../../../src/ash/workbench/contrib/webview/browser/webview.contribution.js';
import { mainWindow } from '../../../src/ash/base/browser/window.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { getSingletonServiceDescriptors } from '../../../src/ash/platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../src/ash/platform/instantiation/common/serviceCollection.js';
import { IWebviewService, type IWebviewElement } from '../../../src/ash/workbench/contrib/webview/browser/webview.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { MemoryFileService } from '../../../src/ash/workbench/contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { createTestFileService, registerTestComponentServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { asWebviewUri } from '../../../src/ash/workbench/contrib/webview/common/webview.js';

const resources = new DisposableStore();
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
const registration = getSingletonServiceDescriptors().find(([id]) => id === IWebviewService)!;
const instantiation = resources.add(registerTestComponentServices(new InstantiationService(new ServiceCollection(registration))));
const service = instantiation.get(IWebviewService);
const received: Array<{ view: string; message: unknown; }> = [];
const first = resources.add(service.createWebviewElement({ title: 'First view', options: { forwardKeyboardEvents: true }, contentOptions: { allowScripts: true } }));
const second = resources.add(service.createWebviewElement({ title: 'Second view', options: {}, contentOptions: { allowScripts: true } }));
for (const [name, view] of [['first', first], ['second', second]] as const) {
	resources.add(view.onMessage(event => received.push({ view: name, message: event.message })));
}
const html = (label: string): string => `<input aria-label="${label}"><output></output>
<script>
const api = acquireAshWebviewApi();
window.addEventListener('message', event => {
	if (event.source !== parent) return;
	document.querySelector('output').textContent = event.data;
	api.postMessage(event.data);
});
</script>`;
const initial = html('First input');
const firstSent = first.postMessage('before mount');
first.setHtml(initial);
first.mountTo(document.querySelector('#first')!, mainWindow);
second.setHtml(html('Second input'));
second.mountTo(document.querySelector('#second')!, mainWindow);
const keyboard: string[] = [];
resources.add(first.onDidKeyboardEvent(event => keyboard.push(event.key)));
const changes: Array<string | undefined> = [];
const nameOf = (view: IWebviewElement | undefined): string | undefined => view === first ? 'first' : view === second ? 'second' : undefined;
resources.add(service.onDidChangeActiveWebview(view => changes.push(nameOf(view as IWebviewElement | undefined))));

declare global {
	interface Window {
		ashWebviewIntegration: {
			readonly received: typeof received;
			readonly keyboard: readonly string[];
			readonly active: string | undefined;
			readonly count: number;
			readonly changes: typeof changes;
			initialSent(): Promise<boolean>;
			sameHtml(): void;
			replace(): Promise<boolean[]>;
			disposeFirst(): Promise<boolean>;
			focusSecond(): void;
			mountFocused(): void;
			mountResources(): Promise<void>;
			readonly resourceReads: readonly string[];
		};
	}
}
window.ashWebviewIntegration = {
	get received() { return received; },
	get keyboard() { return keyboard; },
	get active() { return nameOf(service.activeWebview as IWebviewElement | undefined); },
	get count() { return [...service.webviews].length; },
	get changes() { return changes; },
	initialSent: () => firstSent,
	sameHtml: () => first.setHtml(initial),
	replace: async () => {
		first.setHtml(html('Discarded input'));
		const discarded = first.postMessage('discarded');
		first.setHtml(html('Replacement input'));
		const delivered = first.postMessage('replacement');
		return Promise.all([discarded, delivered]);
	},
	disposeFirst: async () => { first.dispose(); return first.postMessage('late'); },
	focusSecond: () => second.focus(),
	mountFocused: () => {
		const view = resources.add(service.createWebviewElement({ title: 'Loading view', options: { forwardKeyboardEvents: true } }));
		resources.add(view.onDidKeyboardEvent(event => keyboard.push(event.key)));
		view.setHtml('<output>Focused document</output>');
		view.mountTo(document.body, mainWindow);
		view.focus();
	},
	get resourceReads() { return resourceReads; },
	mountResources: async () => {
		const fontUrl = new URL('../../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf', import.meta.url);
		const font = new Uint8Array(await (await fetch(fontUrl)).arrayBuffer());
		const root = URI.parse('file:///workspace');
		const files = new MemoryFileService([
			[URI.parse('file:///workspace/assets/pixel.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"></svg>'],
			[URI.parse('file:///workspace/assets/style.css'), '@font-face{font-family:ResourceFont;src:url(font.ttf)}body{font-family:ResourceFont;color:rgb(1,2,3);background-image:url(pixel.svg)}'],
			[URI.parse('file:///workspace/assets/main.mjs'), 'import { answer } from "./value.mjs";document.body.dataset.answer=String(answer);try{parent.parent.document.body;document.body.dataset.isolated="false"}catch{document.body.dataset.isolated="true"}'],
			[URI.parse('file:///workspace/assets/value.mjs'), 'export const answer=42;'],
			[URI.parse('file:///outside/secret.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="99" height="99"></svg>'],
		]);
		const read = files.readFile.bind(files);
		files.readFile = async resource => {
			resourceReads.push(resource.toString());
			if (resource.path === '/workspace/assets/font.ttf') return { resource, bytes: font, revision: 'font' };
			return read(resource);
		};
		const resourceScope = resources.add(instantiation.createChild(new ServiceCollection([IFileService, resources.add(createTestFileService(files))], registration)));
		const resourceViews = resourceScope.get(IWebviewService);
		for (const [title, allowScripts] of [['Resource view', true], ['Scripts disabled', false]] as const) {
			const view = resources.add(resourceViews.createWebviewElement({ title, options: {}, contentOptions: { allowScripts, localResourceRoots: [root] } }));
			const base = asWebviewUri(URI.parse('file:///workspace/docs/readme.md'));
			const denied = asWebviewUri(URI.parse('file:///outside/secret.svg'));
			view.setHtml(`<base href="${base}"><link rel="stylesheet" href="../assets/style.css"><img alt="Workspace image" src="../assets/pixel.svg"><img alt="Denied image" src="${denied}"><script type="module" src="../assets/main.mjs"></script><script>document.body.dataset.inline="executed"</script>`);
			view.mountTo(document.body, mainWindow);
		}
	},
};

const resourceReads: string[] = [];

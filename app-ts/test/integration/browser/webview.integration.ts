import '../../../src/ash/workbench/contrib/webview/browser/webview.contribution.js';
import { mainWindow } from '../../../src/ash/base/browser/window.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { getSingletonServiceDescriptors } from '../../../src/ash/platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../src/ash/platform/instantiation/common/serviceCollection.js';
import { IWebviewService, type IWebviewElement } from '../../../src/ash/workbench/contrib/webview/browser/webview.js';

const resources = new DisposableStore();
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
const registration = getSingletonServiceDescriptors().find(([id]) => id === IWebviewService)!;
const instantiation = resources.add(new InstantiationService(new ServiceCollection(registration)));
const service = instantiation.get(IWebviewService);
const received: Array<{ view: string; message: unknown; }> = [];
const first = resources.add(service.createWebviewElement({ title: 'First view', options: { forwardKeyboardEvents: true } }));
const second = resources.add(service.createWebviewElement({ title: 'Second view', options: {} }));
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
};

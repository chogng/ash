import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { suite, test, suiteSetup, suiteTeardown } from 'mocha';
import { startMarkdownMathExtension } from '../../../../../../../../test/fixtures/markdownExtension.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { IExtensionHostApi, type ExtensionHostFleetSnapshot, type JsonValue } from '../../../../../../platform/agentHost/common/extensionHostApi.js';
import { createDisconnectedExtensionHostApi } from '../../../../../../platform/agentHost/browser/extensionHostApi.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ConfigurationRegistry } from '../../../../../../platform/configuration/common/configurationRegistry.js';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../../platform/instantiation/common/serviceCollection.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { IMarkdownRendererService, MarkdownRendererService } from '../../../../../../platform/markdown/browser/markdownRenderer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IHoverService } from '../../../../../../platform/hover/browser/hoverService.js';
import { ILinkPresentationService } from '../../../../../../platform/dataChannel/common/dataChannel.js';
import { ChatMarkdownContentPart } from '../../../browser/widget/chatContentParts/chatMarkdownContentPart.js';
import { ChatContentMarkdownRenderer } from '../../../browser/widget/chatContentMarkdownRenderer.js';

let math: Awaited<ReturnType<typeof startMarkdownMathExtension>>;
const snapshot = (): ExtensionHostFleetSnapshot => ({
	generation: 1, extensions: [{
		id: 'vscode.markdown-math', version: '1', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1,
		activationGeneration: 1, incarnation: 1, lifecycle: 'ready', stderr: '', failure: undefined, outputEvents: [],
		registrations: [{ kind: 'dataChannel', registrationId: 'math.render.v2', channelId: 'math.render.v2' }],
	}]
});

function services(overrides: Partial<IExtensionHostApi> = {}): InstantiationService {
	const instance = new InstantiationService(new ServiceCollection([IOpenerService, { open: async () => true } as unknown as IOpenerService]));
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: 'markdown.math.enabled', defaultValue: true, parse: value => Boolean(value) });
	registry.registerConfiguration({ key: 'markdown.math.macros', defaultValue: {}, parse: value => value });
	instance.registerSingleton(IConfigurationService, () => new InMemoryConfigurationService(registry));
	instance.registerInstance(IExtensionHostApi, {
		...createDisconnectedExtensionHostApi(async () => { throw new Error('No host'); }),
		list: async () => snapshot(),
		invoke: (request, signal) => math.invoke(request.registrationId, request.operation, request.payload, signal),
		...overrides,
	});
	instance.registerInstance(IMarkdownRendererService, instance.createInstance(MarkdownRendererService));
	return instance;
}

suite('Shared chat Markdown rendering', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	suiteSetup(async function () { this.timeout(600000); math = await startMarkdownMathExtension(); });
	suiteTeardown(async () => { await math?.dispose(); });

	const corpus = JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures/markdownMath.json'), 'utf8')) as { name: string; markdown: string; formulas: { source: string; display: string; }[]; }[];
	for (const entry of corpus) {
		test(`shared formula syntax: ${entry.name}`, () => {
			using scope = services();
			using renderer = scope.createInstance(ChatContentMarkdownRenderer);
			using result = renderer.render({ value: entry.markdown });
			assert.deepEqual([...result.element.querySelectorAll<HTMLElement>('.ash-katex-container')].map(element => ({ source: element.dataset.latex, display: element.dataset.mathDisplay })), entry.formulas);
		});
	}

	test('coalesces streaming batches and reuses completed results for prose-only updates', async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			let lists = 0;
			const requests: JsonValue[] = [];
			using scope = services({
				list: async () => { lists++; return snapshot(); },
				invoke: async request => { requests.push(request.payload); return { results: [{ status: 'rendered', html: '<math><mi>x</mi></math>' }] }; },
			});
			using renderer = scope.createInstance(ChatContentMarkdownRenderer);
			let current = renderer.render({ value: '$a$' });
			try {
				for (const value of ['$b$', '$x$', '$x$ prose', '$x$ more prose']) {
					current.dispose(); current = renderer.render({ value });
					await new Promise<void>(resolve => setImmediate(resolve));
					mock.timers.tick(1);
				}
				assert.equal(requests.length, 0);
				mock.timers.tick(32);
				await changedUntil(current.element, () => !!current.element.querySelector('math'));
				assert.deepEqual(requests, [{ formulas: [{ source: 'x', display: 'inline' }], macros: {} }]);
				assert.equal(lists, 1);
				current.dispose(); current = renderer.render({ value: '$x$ final prose' });
				await changedUntil(current.element, () => !!current.element.querySelector('math'));
				assert.equal(requests.length, 1);
				assert.equal(lists, 1);
			} finally { current.dispose(); }
		} finally { mock.timers.reset(); }
	});

	test('bounds completed batch reuse and does not cache formulas independently of macro scope', async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			const requests: JsonValue[] = [];
			using scope = services({
				invoke: async request => {
					requests.push(request.payload);
					const { formulas } = request.payload as { formulas: JsonValue[]; };
					return { results: formulas.map(() => ({ status: 'rendered', html: '<math><mi>x</mi></math>' })) };
				}
			});
			using renderer = scope.createInstance(ChatContentMarkdownRenderer);
			for (const value of [...Array.from({ length: 10 }, (_, i) => `$x+${i}$`), '$x+9$', '$x+0$', '$\\gdef\\foo{x}\\foo$ $\\foo$', '$\\gdef\\foo{y}\\foo$ $\\foo$']) {
				using result = renderer.render({ value });
				await new Promise<void>(resolve => setImmediate(resolve));
				mock.timers.tick(32);
				await changedUntil(result.element, () => !!result.element.querySelector('math'));
			}
			assert.equal(requests.length, 13);
			assert.deepEqual(requests.slice(-2), [
				{ formulas: [{ source: '\\gdef\\foo{x}\\foo', display: 'inline' }, { source: '\\foo', display: 'inline' }], macros: {} },
				{ formulas: [{ source: '\\gdef\\foo{y}\\foo', display: 'inline' }, { source: '\\foo', display: 'inline' }], macros: {} },
			]);
		} finally { mock.timers.reset(); }
	});

	test('uses the service code renderer and retains safe HTML and formulas in one result', async () => {
		using scope = services();
		let completed!: () => void;
		const pending = new Promise<void>(resolve => { completed = resolve; });
		scope.get(IMarkdownRendererService).setDefaultCodeBlockRenderer({
			renderCodeBlock: async (_language, text) => {
				const code = document.createElement('code'); code.textContent = `highlighted ${text}`; return code;
			}
		});
		using resultRenderer = scope.createInstance(ChatContentMarkdownRenderer);
		using result = resultRenderer.render({ value: '<details><summary>Details</summary>Retained</details>\n\n$$\\frac{a}{b}+\\sqrt{x}$$\n\n```ts\nconst value = 1;\n```', supportHtml: true }, { asyncRenderCallback: completed });
		await Promise.all([pending, changedUntil(result.element, () => !!result.element.querySelector('math mfrac'))]);
		assert.equal(result.element.querySelector('summary')?.textContent, 'Details');
		assert.ok(result.element.querySelector('math mfrac'));
		assert.equal(result.element.querySelector('.ash-katex-container')?.getAttribute('data-latex'), '\\frac{a}{b}+\\sqrt{x}');
		assert.match(result.element.querySelector('pre')?.textContent ?? '', /highlighted const value = 1;/u);
	});

	test('retains blocked media descriptions without provider URLs or duplicate network policy', () => {
		using scope = services();
		using resultRenderer = scope.createInstance(ChatContentMarkdownRenderer);
		using result = resultRenderer.render({ value: '![Diagram](https://example.com/image)\n\n<video src="https://example.com/movie" title="Demo"/>', supportHtml: true }, { sanitizerConfig: { replaceWithPlaintext: false } });
		assert.equal(result.element.querySelector('img[src],video[src]'), null);
		assert.deepEqual(Array.from(result.element.querySelectorAll('.ash-chat-markdown-media'), item => item.textContent), ['Diagram', 'Demo']);
		assert.doesNotMatch(result.element.innerHTML, /chatgpt|https:\/\/example/u);
	});

	for (const disposeBeforeLoad of [false, true]) {
		test(`pending workspace images ${disposeBeforeLoad ? 'ignore completion after disposal' : 'load before unavailable media receives a text fallback'}`, async () => {
			using resources = new DisposableStore();
			const objectUrl = 'blob:https://ash.invalid/workspace-image';
			const created: Blob[] = [];
			const revoked: string[] = [];
			const urls = document.defaultView!.URL;
			for (const key of ['createObjectURL', 'revokeObjectURL'] as const) {
				const descriptor = Object.getOwnPropertyDescriptor(urls, key);
				Object.defineProperty(urls, key, {
					configurable: true,
					value: key === 'createObjectURL' ? (blob: Blob) => { created.push(blob); return objectUrl; } : (value: string) => { revoked.push(value); },
				});
				resources.add(toDisposable(() => {
					if (descriptor) Object.defineProperty(urls, key, descriptor);
					else Reflect.deleteProperty(urls, key);
				}));
			}
			using scope = services();
			using renderer = scope.createInstance(ChatContentMarkdownRenderer);
			const read = new DeferredPromise<Blob>();
			const completed = new DeferredPromise<void>();
			const requests: string[] = [];
			using result = renderer.render({ value: '![Workspace](ash-remote://ssh+host/image.png)\n\n![Blocked](https://example.com/image)' }, {
				sanitizerConfig: { replaceWithPlaintext: false },
				imageResourceLoader: resource => { requests.push(resource.toString()); return read.p; },
				asyncRenderCallback: () => { void completed.complete(); },
			});
			const image = result.element.querySelector('img[alt="Workspace"]');
			assert.ok(image, 'A pending file image must remain owned by the base renderer');
			assert.equal(image.hasAttribute('src'), false);
			assert.deepEqual(requests, ['ash-remote://ssh+host/image.png']);
			assert.deepEqual(created, []);
			if (disposeBeforeLoad) result.dispose();
			const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
			await read.complete(blob);
			if (disposeBeforeLoad) {
				// Drain the settled resource promise; a disposed render must neither update nor notify.
				await new Promise<void>(resolve => setImmediate(resolve));
				assert.deepEqual(created, []);
				assert.deepEqual(revoked, []);
				assert.equal(image.hasAttribute('src'), false);
				assert.equal(completed.isSettled, false);
			} else {
				await completed.p;
				assert.equal(result.element.querySelector('img'), image);
				assert.equal(image.getAttribute('src'), objectUrl);
				assert.deepEqual(created, [blob]);
				assert.deepEqual(Array.from(result.element.querySelectorAll('.ash-chat-markdown-media'), item => item.textContent), ['Blocked']);
				result.dispose();
				assert.deepEqual(revoked, [objectUrl]);
			}
		});
	}

	test('does not render code examples or currency as math, and retains invalid formulas', async () => {
		using scope = services();
		using resultRenderer = scope.createInstance(ChatContentMarkdownRenderer);
		using result = resultRenderer.render({ value: '`$x$`\n\n```latex\n$$x$$\n```\n\ncost$x$word and $("#id")\n\n$\\notAFormula{x}$\n\n\\(x+1\\)' });
		await changedUntil(result.element, () => !!result.element.querySelector('math'));
		assert.equal(result.element.querySelectorAll('.ash-katex-container').length, 2);
		assert.equal(result.element.querySelector('code')?.textContent, '$x$');
		assert.match(result.element.textContent ?? '', /cost\$x\$word[\s\S]*\\notAFormula\{x\}/u);
	});

	test('sanitizes formula markup, links and inline styles without expanding trust', () => {
		using scope = services();
		using resultRenderer = scope.createInstance(ChatContentMarkdownRenderer);
		using result = resultRenderer.render({ value: '$\\href{javascript:alert(1)}{unsafe}$\n\n<span onclick="alert(1)" style="position:fixed;background:url(https://example.com/tracker);color:red">Visible</span>', supportHtml: true }, { sanitizerConfig: { replaceWithPlaintext: false } });
		assert.equal(result.element.querySelector('[onclick],script,a[href^="javascript:"]'), null);
		assert.match(result.element.textContent ?? '', /Visible/u);
		assert.doesNotMatch(result.element.querySelector('span[style]')?.getAttribute('style') ?? '', /fixed|url\(/u);
	});

	test('activates the declared math capability and sends one ordered batch with message-scoped macros', async () => {
		const requests: unknown[] = [];
		let activated = false;
		using scope = services({
			list: async () => ({ ...snapshot(), extensions: snapshot().extensions.map(runtime => ({ ...runtime, lifecycle: 'dormant', incarnation: undefined, registrations: [] })) }),
			activateByEvent: async request => { requests.push(request.event); activated = true; return snapshot(); },
			invoke: (request, signal) => { requests.push(request.payload); return math.invoke(request.registrationId, request.operation, request.payload, signal); },
		});
		await scope.get(IConfigurationService).updateValue('markdown.math.macros', { '\\RR': '\\mathbb{R}' });
		using resultRenderer = scope.createInstance(ChatContentMarkdownRenderer);
		using result = resultRenderer.render({ value: '$\\newcommand{\\chatfoo}{x^2}\\chatfoo$\n\n$\\chatfoo+\\RR$' });
		await changedUntil(result.element, () => result.element.querySelectorAll('math').length === 2);
		assert.equal(activated, true);
		assert.deepEqual(requests, [
			{ type: 'capability', capability: 'math.render.v2' },
			{ formulas: [{ source: '\\newcommand{\\chatfoo}{x^2}\\chatfoo', display: 'inline' }, { source: '\\chatfoo+\\RR', display: 'inline' }], macros: { '\\RR': '\\mathbb{R}' } },
		]);
		assert.doesNotMatch(result.element.innerHTML, /katex-error|#cc0000/);
	});

	test('follows settings and provider revocation without rerendering unrelated fleet output', async () => {
		using changed = new Emitter<number>();
		let current = snapshot();
		let calls = 0;
		using scope = services({
			list: async () => current,
			onDidChange: listener => changed.event(listener),
			invoke: (request, signal) => { calls++; return math.invoke(request.registrationId, request.operation, request.payload, signal); },
		});
		const configuration = scope.get(IConfigurationService);
		using resultRenderer = scope.createInstance(ChatContentMarkdownRenderer);
		using result = resultRenderer.render({ value: '$x$' });
		await changedUntil(result.element, () => !!result.element.querySelector('math'));
		current = { ...current, generation: 2 }; changed.fire(2);
		await Promise.resolve(); await Promise.resolve();
		assert.equal(calls, 1);
		await configuration.updateValue('markdown.math.enabled', false);
		assert.equal(result.element.textContent?.trim(), '$x$');
		await configuration.updateValue('markdown.math.enabled', true);
		await changedUntil(result.element, () => !!result.element.querySelector('math'));
		current = { generation: 3, extensions: [] }; changed.fire(3);
		await changedUntil(result.element, () => !result.element.querySelector('math'));
		assert.equal(result.element.textContent?.trim(), '$x$');
	});

	test('does not leak macro definitions into another message', async () => {
		using scope = services();
		using firstRenderer = scope.createInstance(ChatContentMarkdownRenderer);
		using first = firstRenderer.render({ value: '$\\newcommand{\\isolated}{x}\\isolated$' });
		await changedUntil(first.element, () => !!first.element.querySelector('math'));
		using secondRenderer = scope.createInstance(ChatContentMarkdownRenderer);
		using second = secondRenderer.render({ value: '$\\isolated$' });
		await changedUntil(second.element, () => !!second.element.querySelector('[data-math-diagnostic=invalidFormula]'));
		assert.match(second.element.querySelector('[data-math-diagnostic]')?.getAttribute('title') ?? '', /This formula could not be rendered/);
		assert.match(second.element.textContent ?? '', /\\isolated/u);
	});

	test('aborts rendering on connection loss and restores formulas after reconnecting', async () => {
		using connection = new Emitter<'ready' | 'stopped'>();
		let entered!: () => void;
		const pending = new Promise<void>(resolve => { entered = resolve; });
		let signal: AbortSignal | undefined;
		let disconnected = false;
		using scope = services({
			onConnectionState: listener => connection.event(listener),
			invoke: (request, cancellation) => {
				if (disconnected) { return math.invoke(request.registrationId, request.operation, request.payload, cancellation); }
				signal = cancellation; entered();
				return new Promise(() => { });
			},
		});
		using resultRenderer = scope.createInstance(ChatContentMarkdownRenderer);
		using result = resultRenderer.render({ value: '$x$' });
		await pending;
		connection.fire('stopped'); disconnected = true;
		assert.equal(signal?.aborted, true);
		assert.equal(result.element.textContent?.trim(), '$x$');
		connection.fire('ready');
		await changedUntil(result.element, () => !!result.element.querySelector('math'));
	});

	test('streaming keeps async math on the current nodes while reusing ordinary paragraphs', async () => {
		let entered!: () => void;
		const pending = new Promise<void>(resolve => { entered = resolve; });
		let firstSignal: AbortSignal | undefined;
		let finish!: (value: JsonValue) => void;
		using scope = services({
			invoke: (request, signal) => {
				if (!firstSignal) {
					firstSignal = signal; entered();
					return new Promise(resolve => { finish = resolve; });
				}
				return math.invoke(request.registrationId, request.operation, request.payload, signal);
			}
		});
		// This message has no links; decorations still own their normal subscription lifetime.
		scope.registerInstance(ILinkPresentationService, { onDidChangeLinkPresentationRules: Event.None } as unknown as ILinkPresentationService);
		scope.registerInstance(IHoverService, {} as IHoverService);
		using part = scope.createInstance(ChatMarkdownContentPart, { ownerDocument: document, markdown: 'Stable paragraph\n\n$x$' });
		await pending;
		const paragraph = part.domNode.querySelector('p');
		part.tryIncrementalUpdate({ value: 'Stable paragraph\n\n$x$\n\nAppended text' }, true);
		assert.equal(firstSignal?.aborted, false);
		assert.equal(part.domNode.querySelector('p'), paragraph);
		finish(await math.invoke('math.render.v2', 'receiveData', { formulas: [{ source: 'x', display: 'inline' }], macros: {} }));
		await changedUntil(part.domNode, () => !!part.domNode.querySelector('math'));
		await Promise.resolve(); await Promise.resolve();
		assert.ok(part.domNode.querySelector('math'));
		assert.doesNotMatch(part.domNode.textContent ?? '', /stale formula/);
	});

	test('cancels retired renders and ignores late results even when the output element is reused', async () => {
		let finish!: (value: JsonValue) => void;
		let entered!: () => void;
		const pending = new Promise<void>(resolve => { entered = resolve; });
		let invocationSignal: AbortSignal | undefined;
		let cancelled!: () => void;
		const aborted = new Promise<void>(resolve => { cancelled = resolve; });
		using scope = services({ invoke: (_request, signal) => { invocationSignal = signal; signal?.addEventListener('abort', cancelled, { once: true }); entered(); return new Promise(resolve => { finish = resolve; }); } });
		const target = document.createElement('div');
		using resultRenderer = scope.createInstance(ChatContentMarkdownRenderer);
		const result = resultRenderer.render({ value: '$old$' }, {}, target);
		await pending;
		result.dispose();
		await aborted;
		assert.equal(invocationSignal?.aborted, true);
		using nextRenderer = scope.createInstance(ChatContentMarkdownRenderer);
		using next = nextRenderer.render({ value: 'New message' }, {}, target);
		finish({ results: [{ status: 'rendered', html: '<span>Stale math</span>' }] });
		await Promise.resolve(); await Promise.resolve();
		assert.equal(target.textContent?.trim(), 'New message');
	});

	test('retains source for unavailable, malformed and failed providers and sanitizes successful output', async () => {
		const responses: readonly JsonValue[] = [null, { html: ['old contract'] }, { results: [] }, { results: [{ status: 'rendered', html: 42 }] }, { results: [{ status: 'source', diagnostic: { code: 'unknown' } }] }];
		for (const response of responses) {
			let entered!: () => void;
			const invoked = new Promise<void>(resolve => { entered = resolve; });
			using scope = services({ invoke: async () => { entered(); return response; } });
			using resultRenderer = scope.createInstance(ChatContentMarkdownRenderer);
			using result = resultRenderer.render({ value: '$x$' });
			await invoked;
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(result.element.textContent?.trim(), '$x$');
		}
		using scope = services({ invoke: async () => ({ results: [{ status: 'rendered', html: '<math><mi>x</mi></math><img src="https://example.com/tracker" onerror="alert(1)"><script>alert(1)</script><span style="position:fixed;color:red">safe</span>' }] }) });
		using resultRenderer = scope.createInstance(ChatContentMarkdownRenderer);
		using result = resultRenderer.render({ value: '$x$' });
		await changedUntil(result.element, () => !!result.element.querySelector('math'));
		assert.equal(result.element.querySelector('img,script,[onerror]'), null);
		assert.doesNotMatch(result.element.innerHTML, /position:fixed|https:\/\/example.com/);
	});

	test('retains source when the provider rejects or throws before returning a promise', async () => {
		for (const synchronous of [true, false]) {
			let entered!: () => void;
			const invoked = new Promise<void>(resolve => { entered = resolve; });
			using scope = services({
				invoke: () => {
					entered();
					if (synchronous) { throw new Error('Unavailable'); }
					return Promise.reject(new Error('Unavailable'));
				}
			});
			using renderer = scope.createInstance(ChatContentMarkdownRenderer);
			using result = renderer.render({ value: '$x$' });
			await invoked;
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.equal(result.element.textContent?.trim(), '$x$');
		}
	});

	test('disabled math does not query or activate the optional provider', async () => {
		const unexpected = async (): Promise<never> => { throw new Error('Disabled math must not request a provider'); };
		let calls = 0;
		using scope = services({ list: () => { calls++; return unexpected(); }, activateByEvent: unexpected, invoke: unexpected });
		await scope.get(IConfigurationService).updateValue('markdown.math.enabled', false);
		using renderer = scope.createInstance(ChatContentMarkdownRenderer);
		using result = renderer.render({ value: '$x$' });
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(calls, 0);
		assert.equal(result.element.textContent?.trim(), '$x$');
	});

	test('keeps SVG dimensions from real formulas and rejects executable or unbounded lengths', async () => {
		using scope = services();
		using resultRenderer = scope.createInstance(ChatContentMarkdownRenderer);
		using result = resultRenderer.render({ value: '$\\sqrt{x}+\\overbrace{a+b}+\\widehat{ABC}$' });
		await changedUntil(result.element, () => !!result.element.querySelector('svg'));
		for (const svg of result.element.querySelectorAll('svg')) {
			assert.match(svg.getAttribute('width') ?? '', /^(?:400em|100%)$/);
			assert.match(svg.getAttribute('height') ?? '', /^[\d.]+em$/);
		}
		using unsafe = services({ invoke: async () => ({ results: [{ status: 'rendered', html: '<svg width="url(https://example.com)" height="100000em"><path d="M0 0"/></svg>' }] }) });
		using rejectedRenderer = unsafe.createInstance(ChatContentMarkdownRenderer);
		using rejected = rejectedRenderer.render({ value: '$x$' });
		await changedUntil(rejected.element, () => !!rejected.element.querySelector('svg'));
		assert.equal(rejected.element.querySelector('svg')?.hasAttribute('width'), false);
		assert.equal(rejected.element.querySelector('svg')?.hasAttribute('height'), false);
	});

	test('preserves successful siblings and presents structured diagnostic reasons as inert text', async () => {
		using scope = services({
			invoke: async (): Promise<JsonValue> => ({
				results: [
					{ status: 'rendered', html: '<math><mi>x</mi></math>' },
					{ status: 'source', diagnostic: { code: 'invalidFormula', message: '<img src=x onerror=alert(1)>' } },
					{ status: 'source', diagnostic: { code: 'outputLimit' } },
				]
			})
		});
		using resultRenderer = scope.createInstance(ChatContentMarkdownRenderer);
		using result = resultRenderer.render({ value: '$x$ $bad$ $large$' });
		await changedUntil(result.element, () => !!result.element.querySelector('[data-math-diagnostic=outputLimit]'));
		assert.equal(result.element.querySelectorAll('math').length, 1);
		assert.equal(result.element.querySelector('[data-math-diagnostic=invalidFormula]')?.textContent, '$bad$');
		assert.match(result.element.querySelector('[data-math-diagnostic=invalidFormula]')?.getAttribute('title') ?? '', /<img src=x/);
		assert.equal(result.element.querySelector('[data-math-diagnostic=outputLimit]')?.textContent, '$large$');
		assert.equal(result.element.querySelector('img,[onerror]'), null);
	});

});

/** Observe the DOM effect of an asynchronous provider instead of sleeping for IPC. */
function changedUntil(element: HTMLElement, predicate: () => boolean): Promise<void> {
	if (predicate()) { return Promise.resolve(); }
	return new Promise(resolve => {
		const observer = new element.ownerDocument.defaultView!.MutationObserver(() => {
			if (predicate()) { observer.disconnect(); resolve(); }
		});
		observer.observe(element, { childList: true, subtree: true, attributes: true });
	});
}

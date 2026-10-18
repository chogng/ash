import '../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import type { OpenOptions } from '../../../opener/common/opener.js';
import { IOpenerService } from '../../../opener/common/opener.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { getSingletonServiceDescriptors } from '../../../instantiation/common/extensions.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IMarkdownRendererService, MarkdownRendererService, openLinkFromMarkdown } from '../../browser/markdownRenderer.js';
import { ensureNoStylesAreLeakedInTestSuite } from '../../../../../../test/unit/documentStyles.js';

suite('Markdown renderer service', () => {
	ensureNoStylesAreLeakedInTestSuite();
	ensureNoDisposablesAreLeakedInTestSuite();

	function createServices(open: IOpenerService['open']): InstantiationService {
		const services = new InstantiationService(new ServiceCollection(...getSingletonServiceDescriptors()));
		services.registerInstance(IOpenerService, { open } as IOpenerService);
		return services;
	}

	test('registered singleton opens links with the Markdown command whitelist', () => {
		const opened: { readonly href: string; readonly options: OpenOptions | undefined; }[] = [];
		using services = createServices(async (href, options) => { opened.push({ href: href.toString(), options }); return true; });
		const renderer = services.get(IMarkdownRendererService);
		assert.equal(renderer, services.get(IMarkdownRendererService));
		const markdown = new MarkdownString('[allowed](command:ash.open) [blocked](command:ash.delete) [web](https://example.com)');
		markdown.isTrusted = { enabledCommands: ['ash.open'] };
		using result = renderer.render(markdown, { ownerDocument: document });
		const anchors = result.element.querySelectorAll<HTMLAnchorElement>('a');
		anchors[0].click();
		anchors[1].click();
		anchors[2].click();
		assert.deepEqual(opened, ['command:ash.open', 'https://example.com'].map(href => ({
			href,
			options: { fromUserGesture: true, allowContributedOpeners: true, allowCommands: ['ash.open'], skipValidation: undefined },
		})));
	});

	test('link helper forwards trust, validation and the opener result', async () => {
		const opened: (OpenOptions | undefined)[] = [];
		using services = createServices(async (_href, options) => { opened.push(options); return false; });
		const opener = services.get(IOpenerService);
		assert.equal(await openLinkFromMarkdown(opener, 'command:ash.open', undefined), false);
		assert.equal(await openLinkFromMarkdown(opener, 'command:ash.open', true, true), false);
		assert.deepEqual(opened, [
			{ fromUserGesture: true, allowContributedOpeners: true, allowCommands: false, skipValidation: undefined },
			{ fromUserGesture: true, allowContributedOpeners: true, allowCommands: true, skipValidation: true },
		]);
	});

	test('caller action receives the source and overrides default opening', () => {
		using services = createServices(async () => { assert.fail('Custom actions must not open twice'); });
		const markdown = new MarkdownString('[source](https://example.com)');
		const activated: unknown[] = [];
		using result = services.get(IMarkdownRendererService).render(markdown, {
			ownerDocument: document,
			actionHandler: (href, source) => { activated.push(href, source); },
		});
		result.element.querySelector<HTMLAnchorElement>('a')!.click();
		assert.deepEqual(activated, ['https://example.com', markdown]);
	});

	test('plain code remains visible before a default renderer is installed', () => {
		using services = createServices(async () => true);
		using result = services.get(IMarkdownRendererService).render({ value: '```unknown\n<content>\n```' }, { ownerDocument: document });
		assert.equal(result.element.querySelector('pre > code')?.textContent, '<content>\n');
	});

	test('default code renderer receives context and the output document', async () => {
		using services = createServices(async () => true);
		const renderer = services.get(IMarkdownRendererService);
		const context = { resource: 'example' };
		const target = document.createElement('section');
		let resolveCompleted!: () => void;
		const completed = new Promise<void>(resolve => { resolveCompleted = resolve; });
		renderer.setDefaultCodeBlockRenderer({
			renderCodeBlock: async (language, value, options) => {
				assert.equal(language, 'ts');
				assert.equal(options.context, context);
				assert.equal(options.ownerDocument, target.ownerDocument);
				const code = target.ownerDocument.createElement('code');
				code.textContent = `highlighted ${value}`;
				return code;
			},
		});
		using result = renderer.render({ value: '```ts extra\nsource\n```' }, { context, asyncRenderCallback: resolveCompleted }, target);
		await completed;
		assert.equal(result.element, target);
		assert.equal(target.querySelector('pre > code')?.textContent, 'highlighted source');
	});

	test('per-render synchronous and asynchronous code callbacks override the default', async () => {
		using services = createServices(async () => true);
		const renderer = services.get(IMarkdownRendererService);
		renderer.setDefaultCodeBlockRenderer({ renderCodeBlock: async () => { assert.fail('Chat code editors must override the default'); } });
		using sync = renderer.render({ value: '```ts\nsource\n```' }, {
			ownerDocument: document,
			codeBlockRendererSync: (_language, value) => { const code = document.createElement('code'); code.textContent = `sync ${value}`; return code; },
		});
		assert.equal(sync.element.querySelector('pre > code')?.textContent, 'sync source');
		let resolveCompleted!: () => void;
		const completed = new Promise<void>(resolve => { resolveCompleted = resolve; });
		using asyncResult = renderer.render({ value: '```ts\nsource\n```' }, {
			ownerDocument: document,
			codeBlockRenderer: async (_language, value) => { const code = document.createElement('code'); code.textContent = `async ${value}`; return code; },
			asyncRenderCallback: resolveCompleted,
		});
		await completed;
		assert.equal(asyncResult.element.querySelector('pre > code')?.textContent, 'async source');
	});

	test('disposal prevents stale code and callbacks from reaching a reused output element', async () => {
		using services = createServices(async () => true);
		const renderer = services.get(IMarkdownRendererService);
		const target = document.createElement('section');
		let resolveCode!: (code: HTMLElement) => void;
		let callbacks = 0;
		const old = renderer.render({ value: '```ts\nold\n```' }, {
			codeBlockRenderer: () => new Promise(resolve => { resolveCode = resolve; }),
			asyncRenderCallback: () => { callbacks += 1; },
		}, target);
		old.dispose();
		using current = renderer.render({ value: 'current' }, {}, target);
		const code = document.createElement('code');
		code.textContent = 'stale';
		resolveCode(code);
		await Promise.resolve();
		await Promise.resolve();
		assert.deepEqual({ text: current.element.textContent?.trim(), callbacks }, { text: 'current', callbacks: 0 });
	});

	test('creation rejects a missing opener registration', () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(MarkdownRendererService), /Unknown service: openerService/);
	});
});

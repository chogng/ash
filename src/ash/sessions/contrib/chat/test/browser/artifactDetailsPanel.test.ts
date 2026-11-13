import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ArtifactDetailsContextView } from '../../browser/artifactDetailsContextView.js';

test('Artifact details describes an action before returning its explicit selection', async () => {
	using lifetime = new DisposableStore();
	const dom = new JSDOM('<body><button>PR Actions</button></body>');
	lifetime.add(toDisposable(() => dom.window.close()));
	const document = dom.window.document;
	const anchor = document.querySelector('button')!;
	const context = lifetime.add(new BrowserContextViewService(document.body));
	const services = lifetime.add(new InstantiationService());
	services.registerInstance(IContextViewService, context);
	const panel = lifetime.add(services.createInstance(ArtifactDetailsContextView, anchor));
	const action = { id: 'merge', label: 'Merge', description: 'Merge the reviewed head commit', prepare: async () => assert.fail('Selection alone does not invoke an action') };
	const binding = { id: 'binding', artifact: { id: 'pr', resource: 'https://example.test/pr', label: 'PR #12' }, actions: [action] };

	anchor.focus();
	const cancelled = panel.choose(binding);
	const title = document.querySelector('h2')!;
	assert.equal(document.activeElement, title);
	title.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert.equal(await cancelled, undefined);
	assert.equal(document.querySelector('[role=dialog]'), null);

	const dismissed = panel.choose(binding);
	const close = [...document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find(button => button.textContent === 'Close artifact details')!;
	close.click();
	assert.equal(await dismissed, undefined);
	assert.equal(document.querySelector('[role=dialog]'), null);

	using cancellation = new CancellationTokenSource();
	const superseded = panel.choose(binding, undefined, cancellation.token);
	cancellation.cancel();
	assert.equal(await superseded, undefined);
	assert.equal(document.querySelector('[role=dialog]'), null);

	const selected = panel.choose(binding);
	const merge = document.querySelector<HTMLButtonElement>('[role=dialog] button')!;
	assert.equal(document.getElementById(merge.getAttribute('aria-describedby')!)?.textContent, action.description);
	merge.click();
	assert.equal(await selected, action);
	assert.equal(document.querySelector('[role=dialog]'), null);
});

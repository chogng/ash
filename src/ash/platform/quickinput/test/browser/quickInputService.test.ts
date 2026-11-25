import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { browserEnvironment } from '../../../../editor/test/browser/testEditorDom.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { themeColorFromId, ThemeIcon } from '../../../../base/common/themables.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { QuickInputList } from '../../browser/quickInputList.js';
import { TestQuickInputService } from './testQuickInputService.js';

test('Quick Pick applies theme color to the decorative icon only', () => {
	using resources = new DisposableStore();
	const document = browserEnvironment.window.document;
	const root = document.createElement('main');
	document.body.append(root);
	resources.add(toDisposable(() => root.remove()));
	const services = resources.add(new InstantiationService());
	resources.add(new TestQuickInputService({ container: root, instantiationService: services }));
	const list = resources.add(services.createInstance(QuickInputList, root, 'menu'));
	list.items = [
		{ label: 'Red', iconClass: ThemeIcon.asClassName(Lxicon.circleFilled), iconColor: themeColorFromId('terminal.ansiRed') },
		{ label: 'Default', iconClass: ThemeIcon.asClassName(Lxicon.circleFilled) },
	];
	const icons = root.querySelectorAll<HTMLElement>('.ash-icon-circle-filled');
	assert.equal(icons.length, 2);
	assert.equal(icons[0].style.color, 'var(--ash-terminal-ansiRed)');
	assert.equal(icons[0].getAttribute('aria-hidden'), 'true');
	assert.equal(icons[1].style.color, '');
});

test('Window Quick Input commands target a modal prompt and release its controller on close', async () => {
	using resources = new DisposableStore();
	const document = browserEnvironment.window.document;
	const root = document.createElement('main');
	document.body.append(root);
	resources.add(toDisposable(() => root.remove()));
	const origin = document.createElement('button');
	root.append(origin);
	const quickInput = resources.add(new TestQuickInputService({ container: root }));
	origin.focus();
	const outside = quickInput.input({ title: 'Window prompt' });
	const modal = document.createElement('dialog');
	modal.setAttribute('open', '');
	const edit = document.createElement('button');
	modal.append(edit);
	root.append(modal);
	edit.focus();
	const cancellation = resources.add(new Emitter<void>());
	const token: CancellationToken = { isCancellationRequested: false, onCancellationRequested: cancellation.event };
	const first = quickInput.input({ title: 'Member name' }, token);
	assert.equal(await outside, undefined);
	assert.ok(modal.querySelector('.ash-quick-input-host'));
	const input = modal.querySelector<HTMLInputElement>('input')!;
	assert.equal(document.activeElement, input);
	input.value = 'Casey';
	input.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	await quickInput.accept();
	assert.equal(await first, 'Casey');
	assert.equal(cancellation.hasListeners(), false);
	assert.equal(document.activeElement, edit);
	const second = quickInput.input({ title: 'Responsibility' });
	await quickInput.cancel();
	assert.equal(await second, undefined);
	const pending = quickInput.input({ title: 'Pending prompt' });
	modal.removeAttribute('open');
	modal.dispatchEvent(new browserEnvironment.window.Event('close'));
	assert.equal(await pending, undefined);
	assert.equal(modal.querySelector('.ash-quick-input-host'), null);
	origin.focus();
	const last = quickInput.input({ title: 'Window prompt after modal close' });
	assert.ok(quickInput.currentQuickInput);
	assert.equal(modal.querySelector('.ash-quick-input-host'), null);
	await quickInput.cancel();
	assert.equal(await last, undefined);
});

test('Quick Input releases the cancellation listener if cancelled during registration', async () => {
	using resources = new DisposableStore();
	const document = browserEnvironment.window.document;
	const root = document.createElement('main');
	document.body.append(root);
	resources.add(toDisposable(() => root.remove()));
	const quickInput = resources.add(new TestQuickInputService({ container: root }));
	const cancellation = resources.add(new Emitter<void>());
	let cancelled = false;
	const token: CancellationToken = {
		get isCancellationRequested() { return cancelled; },
		onCancellationRequested(listener) {
			const subscription = cancellation.event(listener);
			cancelled = true;
			cancellation.fire();
			return subscription;
		},
	};

	assert.equal(await quickInput.input({ title: 'Cancelled prompt' }, token), undefined);
	assert.equal(quickInput.currentQuickInput, undefined);
	assert.equal(cancellation.hasListeners(), false);
});

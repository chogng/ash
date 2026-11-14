import assert from 'node:assert/strict';
import { suiteSetup, suiteTeardown, test } from 'mocha';
import { browserEnvironment as dom } from '../../../editor/test/browser/testEditorDom.js';
import { getWindows } from '../../browser/window.js';
import { toDisposable } from '../../common/lifecycle.js';
import { h } from '../../browser/dom.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';

getWindows();
const scrollIntoView = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'scrollIntoView');
const scrollTo = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, 'scrollTo');
suiteSetup(async () => {
	Object.defineProperty(dom.window.Element.prototype, 'scrollIntoView', {
		configurable: true,
		value(): void { },
	});
	Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollTo', {
		configurable: true,
		value(): void { },
	});
	await import('../../browser/ui/selectbox/selectbox.js');
});
suiteTeardown(() => {
	if (scrollIntoView) Object.defineProperty(dom.window.Element.prototype, 'scrollIntoView', scrollIntoView);
	else Reflect.deleteProperty(dom.window.Element.prototype, 'scrollIntoView');
	if (scrollTo) Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollTo', scrollTo);
	else Reflect.deleteProperty(dom.window.HTMLElement.prototype, 'scrollTo');
});
ensureNoDisposablesAreLeakedInTestSuite();

test('SelectBox uses the default chevron trigger and trailing selected check inside a themed ContextView', async () => {
	const [{ ContextView }, { appendIcon }, { SelectBox }, { Lxicon }] = await Promise.all([
		import('../../browser/ui/contextview/contextview.js'),
		import('../../browser/ui/lxicons/lxicon.js'),
		import('../../browser/ui/selectbox/selectbox.js'),
		import('../../common/lxicons.js'),
	]);
	const createdElements: HTMLElement[] = [];
	const originalCreateElement = dom.window.document.createElement;
	using restoreCreateElement = toDisposable(() => { dom.window.document.createElement = originalCreateElement; });
	const createElement = originalCreateElement.bind(dom.window.document);
	dom.window.document.createElement = ((...args: Parameters<typeof createElement>) => {
		const element = createElement(...args);
		createdElements.push(element);
		return element;
	}) as typeof createElement;
	const popupLists = () => createdElements.filter(element => element.classList.contains('ash-list') && element.childElementCount > 0).length;
	const host = h(dom.window.document, 'main');
	dom.window.document.body.append(host);
	using removeHost = toDisposable(() => host.remove());
	using contextView = new ContextView(host);
	using selectBox = new SelectBox(dom.window.document.body, {
		options: [
			{ value: 'auto', label: 'Auto' },
			{ value: 'on', label: 'On' },
			{ value: 'off', label: 'Off' },
		],
		selectedValue: 'auto',
		ariaLabel: 'Screen reader optimization',
		contextViewProvider: contextView,
	});
	host.append(selectBox.element);

	const button = selectBox.element.querySelector<HTMLButtonElement>('.ash-select-box-button')!;
	button.getBoundingClientRect = () => ({ width: 192 } as DOMRect);
	const indicator = selectBox.element.querySelector<HTMLElement>('.ash-dropdown-indicator')!;
	const expectedIndicator = h(dom.window.document, 'span');
	appendIcon(Lxicon.chevronDown, expectedIndicator);
	assert.equal(indicator.innerHTML, expectedIndicator.innerHTML);

	assert.equal(button.hasAttribute('aria-activedescendant'), false);
	assert.equal(popupLists(), 0, 'a collapsed select must not retain a popup list');
	selectBox.show();
	assert.equal(contextView.element.parentElement, host);
	assert.equal(contextView.element.classList.contains('ash-context-view-default'), true);
	let list = contextView.element.querySelector<HTMLElement>('.ash-select-box-list')!;
	assert.equal(popupLists(), 1);
	assert.ok(list);
	assert.equal(list.style.getPropertyValue('--dropdown-trigger-width'), '192px');
	const selected = list.querySelector<HTMLElement>('.ash-select-box-option-selected')!;
	const check = selected.querySelector<HTMLElement>('.ash-select-box-option-check')!;
	const expectedCheck = h(dom.window.document, 'span');
	appendIcon(Lxicon.check, expectedCheck);
	assert.equal(selected.querySelector('.ash-select-box-option-content')?.lastElementChild, check);
	assert.equal(check.innerHTML, expectedCheck.innerHTML);
	assert.equal(selected.getAttribute('aria-selected'), 'true');
	assert.equal(button.getAttribute('aria-activedescendant'), selected.id);
	selectBox.hide();
	assert.equal(button.hasAttribute('aria-activedescendant'), false);
	selectBox.value = 'on';
	assert.equal(button.hasAttribute('aria-activedescendant'), false);
	selectBox.show();
	const activeId = button.getAttribute('aria-activedescendant')!;
	assert.equal(dom.window.document.getElementById(activeId)?.textContent?.includes('On'), true);
	selectBox.hide();
	assert.equal(button.hasAttribute('aria-activedescendant'), false);
	selectBox.value = undefined;
	selectBox.show();
	assert.equal(selectBox.value, undefined);
	assert.equal(selectBox.selectedIndex, -1);
	assert.equal(button.hasAttribute('aria-activedescendant'), false);
	list = contextView.element.querySelector<HTMLElement>('.ash-select-box-list')!;
	assert.equal(list.querySelector('.focused, [aria-selected="true"]'), null);
	selectBox.hide();

	for (let iteration = 0; iteration < 20; iteration++) {
		selectBox.setOptions([
			{ value: 'auto', label: '自动' },
			{ value: 'disabled', label: '不可用', disabled: true },
			{ value: 'on', label: '开启' },
		]);
		selectBox.value = 'auto';
		selectBox.show();
		assert.equal(popupLists(), 1);
		const popup = contextView.element.querySelector<HTMLElement>('.ash-select-box-list')!;
		popup.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		popup.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		assert.equal(selectBox.value, 'on');
		assert.equal(selectBox.selectedIndex, 2);
		assert.equal(button.textContent?.includes('开启'), true);
		assert.equal(button.hasAttribute('aria-activedescendant'), false);
		assert.equal(button.hasAttribute('aria-controls'), false);
		assert.equal(popupLists(), 0, 'closed popups must release their rows and listeners after every use');
	}
	selectBox.show();
	selectBox.enabled = false;
	assert.equal(popupLists(), 0, 'disabling an open select must release its popup');
	selectBox.enabled = true;
	selectBox.show();
	selectBox.dispose();
	contextView.dispose();
});

test('unopened default selects allocate no popup hosts and retain current options on first use', async () => {
	const { SelectBox } = await import('../../browser/ui/selectbox/selectbox.js');
	const host = h(dom.window.document, 'main');
	dom.window.document.body.append(host);
	using removeHost = toDisposable(() => host.remove());
	const popupCount = () => dom.window.document.querySelectorAll('.ash-context-view').length;
	const baseline = popupCount();
	using select = new SelectBox(host, { options: [{ value: 'one', label: 'One' }] });
	assert.equal(popupCount(), baseline);
	select.setOptions([{ value: 'one', label: '一' }, { value: 'two', label: '二' }]);
	select.value = 'two';
	assert.equal(popupCount(), baseline);
	select.show();
	const popup = dom.window.document.querySelector<HTMLElement>('.ash-select-box-list')!;
	assert.equal(popup.querySelector('[aria-selected="true"]')?.textContent, '二');
	select.setOptions([{ value: 'two', label: '更新' }, { value: 'three', label: '三' }]);
	assert.equal(select.selectedIndex, 0);
	assert.equal(popup.querySelector('[aria-selected="true"]')?.textContent, '更新');
	select.hide();
	assert.equal(select.value, 'two');
	assert.equal(popup.childElementCount, 0);
	select.dispose();
	assert.equal(popupCount(), baseline);
});

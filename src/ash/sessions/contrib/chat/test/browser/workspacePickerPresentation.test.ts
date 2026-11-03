import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IAction } from '../../../../../base/common/actions.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ActionWidgetService, type IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import type { IActionListDelegate, IActionListItem } from '../../../../../platform/actionWidget/browser/actionList.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../../../platform/contextview/browser/contextViewService.js';
import { WorkspacePicker } from '../../browser/sessionWorkspacePicker.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspacesService } from '../../../../../platform/workspaces/common/workspaces.js';

function fixture(useRealWidget = false) {
	const lifetime = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body></body>');
	lifetime.add(toDisposable(() => dom.window.close()));
	const services = lifetime.add(new InstantiationService());
	services.registerInstance(IQuickInputService, {} as IQuickInputService);
	const changed = lifetime.add(new Emitter<void>());
	let items: readonly IActionListItem<IAction>[] = [];
	let delegate: IActionListDelegate<IAction> | undefined;
	let shown = 0;
	let closed = 0;
	let selected = 0;
	const errors: unknown[] = [];
	const dismiss = () => {
		const current = delegate;
		if (!current) { return; }
		delegate = undefined;
		closed++;
		current.onHide();
	};
	const stubWidget = {
		show: (_user: string, _preview: boolean, choices: typeof items, callbacks: IActionListDelegate<IAction>) => {
			shown++;
			items = choices;
			delegate = callbacks;
		},
		updateItems: (choices: typeof items) => { items = choices; },
		hide: dismiss,
	} as unknown as IActionWidgetService;
	services.registerInstance(IContextViewService, lifetime.add(new BrowserContextViewService(dom.window.document.body)));
	services.registerInstance(IConfigurationService, lifetime.add(new InMemoryConfigurationService()));
	const actionWidget = useRealWidget ? lifetime.add(services.createInstance(ActionWidgetService)) : stubWidget;
	services.registerInstance(INotificationService, { error: (error: unknown) => errors.push(error) } as unknown as INotificationService);
	const choices: IAction[] = [{ id: 'folder', label: 'Folder', tooltip: '/project', enabled: true, checked: true, run: () => { selected++; } }];
	const action = { id: 'workspace', label: 'Project', tooltip: 'Workspace: Project', enabled: true, run: (): void => control.showPicker(choices) };
	services.registerInstance(IWorkspacesService, { getRecentlyOpened: async () => ({ workspaces: [] }) } as unknown as IWorkspacesService);
	const control: WorkspacePicker = lifetime.add(services.createInstance(WorkspacePicker, { trigger: { actionWidget, action, onDidChange: changed.event, placeholder: 'Choose a workspace' } }));
	control.render(dom.window.document.body);
	const button = dom.window.document.querySelector('button')!;
	return {
		control, action, changed, choices, dismiss, button, errors, actionWidget,
		get items() { return items; },
		filter(text: string) {
			const input = dom.window.document.querySelector<HTMLInputElement>('.ash-action-widget-filter input')!;
			input.value = text;
			input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
		},
		select(item: IActionListItem<IAction>) { if (item.item) { void delegate?.onSelect(item.item); } },
		get shown() { return shown; }, get closed() { return closed; }, get selected() { return selected; },
		press(key: string) { button.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); },
		[Symbol.dispose]() { lifetime.dispose(); },
	};
}

test('Workspace picker opens with arrows, accepts once, and restores its trigger', () => {
	using f = fixture();
	f.press('ArrowDown');
	assert.equal(f.shown, 1);
	assert.equal(f.button.getAttribute('aria-expanded'), 'true');
	const choice = f.items[0];
	assert.ok(choice && !('type' in choice));
	assert.equal(choice.checked, true);
	f.select(choice);
	assert.equal(f.selected, 1);
	assert.equal(f.closed, 1);
	assert.equal(f.button.getAttribute('aria-expanded'), 'false');
	assert.equal(f.button.ownerDocument.activeElement, f.button);
	f.select(choice);
	assert.equal(f.selected, 1);
});

test('Workspace picker preserves selection on cancellation and projects label and disabled changes', () => {
	using f = fixture();
	f.button.click();
	f.dismiss();
	assert.equal(f.selected, 0);
	assert.equal(f.button.ownerDocument.activeElement, f.button);
	f.action.label = 'Other project';
	f.action.tooltip = 'Workspace: Other project';
	f.changed.fire();
	assert.equal(f.button.textContent, 'Other project');
	assert.equal(f.button.getAttribute('aria-label'), 'Workspace: Other project');
	f.press('ArrowUp');
	f.action.enabled = false;
	f.changed.fire();
	assert.equal(f.button.disabled, true);
	assert.equal(f.button.tabIndex, -1);
	assert.equal(f.button.getAttribute('aria-expanded'), 'false');
	f.press('ArrowDown');
	f.button.click();
	assert.equal(f.shown, 2);
});

test('Closing or disposing workspace choices cancels provider loading and ignores late results', async () => {
	for (const dispose of [false, true]) {
		using f = fixture();
		const result = new DeferredPromise<readonly IAction[]>();
		let token: CancellationToken | undefined;
		f.control.showPicker(f.choices, cancellation => { token = cancellation; return result.p; });
		const items = f.items;
		if (dispose) { f.control.dispose(); }
		else { f.dismiss(); }
		assert.equal(token?.isCancellationRequested, true);
		await result.complete([{ ...f.choices[0]!, id: 'late', label: 'Late folder' }]);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(f.items, items);
		assert.equal(f.selected, 0);
		assert.deepEqual(f.errors, []);
	}
});

test('Workspace provider failure leaves immediate choices usable and reports the error', async () => {
	using f = fixture();
	const failure = new Error('Cannot read worktrees');
	f.control.showPicker(f.choices, async () => { throw failure; });
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(f.errors, [failure]);
	const choice = f.items[0];
	assert.ok(choice && !('type' in choice));
	f.select(choice);
	assert.equal(f.selected, 1);
});

test('Workspace picker limits unfiltered recents and finds older folders while searching', async () => {
	using f = fixture(true);
	const recents = Array.from({ length: 12 }, (_, index) => ({
		...f.choices[0]!, id: `recent-${index}`, label: `Recent folder ${index}`, recent: true,
	}));
	const visibleLabels = () => [...f.button.ownerDocument.querySelectorAll('.ash-action-widget [role=menuitemradio]')]
		.map(row => row.getAttribute('aria-label'));
	const defaultLabels = ['Folder', ...recents.slice(0, 10).map(action => action.label)];
	const load = async () => [...f.choices, ...recents];

	f.control.focus();
	f.control.showPicker(f.choices, load);
	f.filter('Recent folder 11');
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(visibleLabels(), ['Recent folder 11']);
	f.filter('  ');
	assert.deepEqual(visibleLabels(), defaultLabels);
	f.filter('Recent folder 10');
	assert.deepEqual(visibleLabels(), ['Recent folder 10']);

	f.actionWidget.hide();
	assert.equal(f.button.ownerDocument.activeElement, f.button);
	f.control.showPicker(f.choices, load);
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(visibleLabels(), defaultLabels);
});

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
import { IQuickInputService, type IQuickPick, type IQuickPickDidAcceptEvent, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { WorkspacePicker } from '../../browser/sessionWorkspacePicker.js';
import { IWorkspacesService } from '../../../../../platform/workspaces/common/workspaces.js';

function fixture() {
	const lifetime = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body></body>');
	lifetime.add(toDisposable(() => dom.window.close()));
	const services = lifetime.add(new InstantiationService());
	const changed = lifetime.add(new Emitter<void>());
	const accepted = lifetime.add(new Emitter<IQuickPickDidAcceptEvent>());
	const hidden = lifetime.add(new Emitter<void>());
	const loaded = lifetime.add(new Emitter<void>());
	let items: readonly IQuickPickItem[] = [];
	let shown = 0;
	let closed = 0;
	let selected = 0;
	const errors: unknown[] = [];
	const picker = {
		get items() { return items; },
		set items(value: readonly IQuickPickItem[]) { items = value; loaded.fire(); },
		selectedItems: [] as readonly IQuickPickItem[],
		onDidAccept: accepted.event, onDidHide: hidden.event,
		show() { shown++; }, dispose() { closed++; }, [Symbol.dispose]() { closed++; },
	} as unknown as IQuickPick<IQuickPickItem>;
	services.registerInstance(IQuickInputService, { createQuickPick: () => picker } as unknown as IQuickInputService);
	services.registerInstance(INotificationService, { error: (error: unknown) => errors.push(error) } as unknown as INotificationService);
	const choices: IAction[] = [{ id: 'folder', label: 'Folder', tooltip: '/project', enabled: true, checked: true, run: () => { selected++; } }];
	const action = { id: 'workspace', label: 'Project', tooltip: 'Workspace: Project', enabled: true, run: (): void => control.showPicker(choices) };
	services.registerInstance(IWorkspacesService, { getRecentlyOpened: async () => ({ workspaces: [] }) } as unknown as IWorkspacesService);
	const control: WorkspacePicker = lifetime.add(services.createInstance(WorkspacePicker, { trigger: { action, onDidChange: changed.event, placeholder: 'Choose a workspace' } }));
	control.render(dom.window.document.body);
	const button = dom.window.document.querySelector('button')!;
	return {
		control, action, changed, picker, choices, accepted, hidden, loaded, button, errors,
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
	const choice = f.picker.items[0];
	assert.ok(choice && !('type' in choice));
	assert.equal(choice.picked, true);
	f.picker.selectedItems = [choice];
	f.accepted.fire({ inBackground: false });
	assert.equal(f.selected, 1);
	assert.equal(f.closed, 1);
	assert.equal(f.button.getAttribute('aria-expanded'), 'false');
	assert.equal(f.button.ownerDocument.activeElement, f.button);
	f.accepted.fire({ inBackground: false });
	assert.equal(f.selected, 1);
});

test('Workspace picker preserves selection on cancellation and projects label and disabled changes', () => {
	using f = fixture();
	f.button.click();
	f.hidden.fire();
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
		const items = f.picker.items;
		assert.equal(f.picker.busy, true);
		if (dispose) { f.control.dispose(); }
		else { f.hidden.fire(); }
		assert.equal(token?.isCancellationRequested, true);
		await result.complete([{ ...f.choices[0]!, id: 'late', label: 'Late folder' }]);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(f.picker.items, items);
		assert.equal(f.selected, 0);
		assert.deepEqual(f.errors, []);
	}
});

test('Workspace provider failure leaves immediate choices usable and reports the error', async () => {
	using f = fixture();
	const failure = new Error('Cannot read worktrees');
	f.control.showPicker(f.choices, async () => { throw failure; });
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(f.picker.busy, false);
	assert.deepEqual(f.errors, [failure]);
	const choice = f.picker.items[0];
	assert.ok(choice && !('type' in choice));
	f.picker.selectedItems = [choice];
	f.accepted.fire({ inBackground: false });
	assert.equal(f.selected, 1);
});

import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import { IContextKeyService, ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { ILayoutService, BrowserLayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IStatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { StatusbarPart, StatusbarService } from '../../../../browser/parts/statusbar/statusbarPart.js';
import { createTestComponentServices } from '../../../common/testEditorServices.js';

class StatusbarFixture extends Disposable {
	readonly browser = new JSDOM('<!doctype html><body><textarea aria-label="Editor"></textarea></body>', {
		url: 'https://ash.test',
	});
	readonly document = this.browser.window.document;
	readonly services = this._register(createTestComponentServices(undefined, undefined, this.document));
	readonly entries = this._register(new StatusbarService());
	readonly commands = this._register(new CommandService(this.services));
	readonly menus: IContextMenuDelegate[] = [];
	readonly part: StatusbarPart;
	readonly editor = this.document.querySelector('textarea')!;

	constructor() {
		super();
		this._register(toDisposable(() => this.browser.window.close()));
		this.services.registerInstance(IStatusbarService, this.entries);
		this.services.registerInstance(
			ILayoutService,
			this._register(new BrowserLayoutService({ root: this.document.body, focus: () => this.editor.focus() })),
		);
		this.services.registerInstance(IContextKeyService, this._register(new ContextKeyService()));
		this.services.registerInstance(IContextMenuService, {
			contextMenuStyle: 'custom',
			onDidShowContextMenu: Event.None,
			onDidHideContextMenu: Event.None,
			showContextMenu: delegate => {
				this.menus.push(delegate as IContextMenuDelegate);
			},
			hideContextMenu() {},
		});
		this._register(
			this.entries.addEntry({ text: 'branch', run() {} }, { id: 'branch', alignment: StatusbarAlignment.Left }),
		);
		this._register(
			this.entries.addEntry(
				{ text: 'language', run() {} },
				{ id: 'language', alignment: StatusbarAlignment.Right, priority: 80 },
			),
		);
		this._register(
			this.entries.addEntry(
				{ text: 'cursor', run() {} },
				{ id: 'cursor', alignment: StatusbarAlignment.Right, priority: 40 },
			),
		);
		this.part = this._register(this.services.createInstance(StatusbarPart, this.document.body));
	}
}

test('registered status bar commands reach the live Part, preserve its focus and skip hidden entries', async () => {
	using fixture = new StatusbarFixture();
	const { part, commands, document, editor } = fixture;
	await commands.executeCommand('workbench.action.focusStatusBar');
	assert.equal(document.activeElement, part.domNode);
	await commands.executeCommand('workbench.statusBar.focusLast');
	assert.equal(document.activeElement?.textContent, 'language');
	part.updateEntryVisibility('cursor', false);
	await commands.executeCommand('workbench.statusBar.focusPrevious');
	assert.equal(document.activeElement?.textContent, 'branch');
	editor.focus();
	await commands.executeCommand('workbench.action.focusStatusBar');
	assert.equal(document.activeElement?.textContent, 'branch');
	await commands.executeCommand('workbench.statusBar.clearFocus');
	assert.equal(document.activeElement, part.domNode);
	await commands.executeCommand('workbench.statusBar.clearFocus');
	assert.equal(document.activeElement, editor);
	await commands.executeCommand('workbench.statusBar.focusFirst');
	assert.equal(document.activeElement?.textContent, 'branch');
});

test('status bar menus derive their checked state from the model, restore entries and cancel on Part disposal', () => {
	using fixture = new StatusbarFixture();
	const { part, document, browser, menus } = fixture;
	part.focusNextEntry();
	const branch = document.activeElement!;
	branch.dispatchEvent(
		new browser.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }),
	);
	const menu = menus[0]!;
	const actions = menu.getActions();
	const toggle = actions[0]!;
	assert.equal(toggle.checked, true);
	actions.at(-1)!.run();
	assert.equal(toggle.checked, false);
	assert.equal(part.isEntryVisible('branch'), false);
	assert.equal(fixture.entries.getEntries(StatusbarAlignment.Left)[0]?.id, 'branch');
	toggle.run();
	assert.equal(toggle.checked, true);
	assert.equal(part.isEntryVisible('branch'), true);
	menu.onHide?.(false);
	assert.equal(document.activeElement, part.domNode);
	part.domNode.dispatchEvent(new browser.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
	const token = menus[1]!.cancellationToken!;
	assert.equal(token.isCancellationRequested, false);
	part.dispose();
	assert.equal(token.isCancellationRequested, true);
	assert.throws(() => fixture.entries.getPart(document.body), /No status bar/);
});

test('status bar service resolves each window view and hidden Parts cannot take focus', async () => {
	using main = new StatusbarFixture();
	using auxiliary = new StatusbarFixture();
	assert.equal(main.entries.getPart(main.document.body), main.part);
	assert.equal(main.entries.getPart(auxiliary.document.body), auxiliary.part);
	auxiliary.part.setVisible(false);
	auxiliary.editor.focus();
	await auxiliary.commands.executeCommand('workbench.action.focusStatusBar');
	await auxiliary.commands.executeCommand('workbench.statusBar.focusNext');
	assert.equal(auxiliary.document.activeElement, auxiliary.editor);
	assert.equal(main.document.activeElement, main.document.body);
});

test('status bar construction requires the registered entry and context menu owners', () => {
	const browser = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	try {
		using services = createTestComponentServices(undefined, undefined, browser.window.document);
		assert.throws(
			() => services.createInstance(StatusbarPart, browser.window.document.body),
			/Unknown service: statusbarService/,
		);
		using entries = new StatusbarService();
		services.registerInstance(IStatusbarService, entries);
		assert.throws(
			() => services.createInstance(StatusbarPart, browser.window.document.body),
			/Unknown service: contextMenuService/,
		);
	} finally {
		browser.window.close();
	}
});

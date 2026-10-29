import type { IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import type { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter } from '../../../../../base/common/event.js';
import { resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { AgentSessionsControl } from '../../browser/agentSessions/agentSessionsControl.js';
import type { IAgentSessionListItem, IAgentSessionsModel } from '../../browser/agentSessions/agentSessionsModel.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';

test('Agent Sessions keeps visible rows through catalog updates and translates its search and groups', () => {
	const document = new JSDOM('<!doctype html><body></body>');
	const changed = new Emitter<void>();
	const opened: string[] = [];
	let items: readonly IAgentSessionListItem[] = [
		{
			id: 'draft:one',
			title: 'Draft One',
			description: 'Draft',
			kind: 'draft',
			active: false,
			getActions: () => [],
			open: () => opened.push('draft:one'),
		},
		{
			id: 'session:one',
			title: 'First Session',
			description: '',
			kind: 'session',
			active: true,
			getActions: () => [],
			open: () => opened.push('session:one'),
		},
	];
	const model: IAgentSessionsModel = {
		onDidChange: changed.event,
		get items() {
			return items;
		},
		state: 'ready',
		error: undefined,
	};
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN');
	assert.ok(chinese);
	setNlsResolver((bundle, key, fallback) => chinese.bundles[bundle]?.[key] ?? fallback);
	try {
		using control = new AgentSessionsControl(document.window.document.body, model, {
			showContextMenu() {},
		} as unknown as IContextMenuService);
		assert.equal(control.domNode.querySelector<HTMLInputElement>('input')?.placeholder, '搜索会话');
		assert.deepEqual(
			[...control.domNode.querySelectorAll('h3')].map(heading => heading.textContent),
			['草稿', '会话'],
		);
		const firstRow = control.domNode.querySelector<HTMLButtonElement>('.ash-agent-session-row[aria-current="page"]');
		assert.equal(firstRow?.title, 'First Session');
		const search = control.domNode.querySelector<HTMLInputElement>('input');
		assert.ok(search);
		search.focus();
		search.dispatchEvent(new document.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		assert.equal(document.window.document.activeElement?.closest('button')?.title, 'Draft One');
		control.domNode.querySelector<HTMLButtonElement>('.ash-agent-session-row')?.dispatchEvent(new document.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		assert.equal(document.window.document.activeElement, firstRow);
		items = [items[0]!, { ...items[1]!, title: 'Renamed Session' }];
		changed.fire();
		assert.equal(control.domNode.querySelector<HTMLButtonElement>('.ash-agent-session-row[aria-current="page"]'), firstRow);
		firstRow?.click();
		assert.deepEqual(opened, ['session:one']);
		search.value = 'missing';
		search.dispatchEvent(new document.window.Event('input', { bubbles: true }));
		assert.equal(control.domNode.querySelector('.ash-agent-sessions-empty')?.textContent, '没有匹配的会话');
	} finally {
		resetNlsResolver();
		changed.dispose();
		document.window.close();
	}
});

test('Agent Sessions exposes the captured row menu by pointer and keyboard and retains grouped rows', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using changed = new Emitter<void>();
	let menu: IContextMenuDelegate | undefined;
	const invoked: string[] = [];
	let item: IAgentSessionListItem = {
		id: 'background',
		title: 'Background',
		description: '',
		kind: 'session',
		active: false,
		open: () => invoked.push('open'),
		getActions: () => [{ id: 'rename', label: 'Rename', enabled: true, tooltip: '', run: () => invoked.push('rename') }],
	};
	try {
		using control = new AgentSessionsControl(
			dom.window.document.body,
			{
				onDidChange: changed.event,
				get items() {
					return [item];
				},
				state: 'ready',
				error: undefined,
			},
			{
				showContextMenu: (value: IContextMenuDelegate) => {
					menu = value;
				},
			} as IContextMenuService,
		);
		const row = control.domNode.querySelector<HTMLButtonElement>('.ash-agent-session-row')!;
		const more = control.domNode.querySelector<HTMLButtonElement>('.ash-agent-session-more')!;
		more.click();
		assert.equal(more.getAttribute('aria-expanded'), 'true');
		await menu!.getActions()[0]!.run();
		assert.deepEqual(invoked, ['rename']);
		menu!.onHide?.(true);
		assert.equal(more.getAttribute('aria-expanded'), 'false');
		row.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
		assert.ok(menu);
		menu.onHide?.(true);
		item = { ...item, pinned: true, group: { sectionId: 'group', name: 'Shared group' } };
		changed.fire();
		assert.equal(control.domNode.querySelector('[data-section="pinned"] .ash-agent-session-row'), row);
		item = { ...item, pinned: false };
		changed.fire();
		assert.equal(control.domNode.querySelector('[data-section="group:group"] .ash-agent-session-row'), row);
		assert.equal(control.domNode.querySelector('h3')?.textContent, 'Shared group');
	} finally {
		dom.window.close();
	}
});

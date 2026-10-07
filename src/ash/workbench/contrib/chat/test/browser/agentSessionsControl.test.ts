import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter } from '../../../../../base/common/event.js';
import { resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { AgentSessionsControl } from '../../browser/agentSessions/agentSessionsControl.js';
import type { IAgentSessionListItem, IAgentSessionsModel } from '../../browser/agentSessions/agentSessionsModel.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';

test('Agent Sessions keeps visible rows through catalog updates and translates its search and groups', () => {
	const document = new JSDOM('<!doctype html><body></body>');
	const changed = new Emitter<void>();
	const opened: string[] = [];
	let items: readonly IAgentSessionListItem[] = [
		{ id: 'draft:one', title: 'Draft One', description: 'Draft', kind: 'draft', active: false, open: () => opened.push('draft:one') },
		{ id: 'session:one', title: 'First Session', description: '', kind: 'session', active: true, open: () => opened.push('session:one') },
	];
	const model: IAgentSessionsModel = {
		onDidChange: changed.event,
		get items() { return items; },
		state: 'ready',
		error: undefined,
	};
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN');
	assert.ok(chinese);
	setNlsResolver((bundle, key, fallback) => chinese.bundles[bundle]?.[key] ?? fallback);
	try {
		using control = new AgentSessionsControl(document.window.document.body, model);
		assert.equal(control.domNode.querySelector<HTMLInputElement>('input')?.placeholder, '搜索会话');
		assert.deepEqual([...control.domNode.querySelectorAll('h3')].map(heading => heading.textContent), ['草稿', '会话']);
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

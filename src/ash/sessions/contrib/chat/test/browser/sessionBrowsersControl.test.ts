import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { test } from 'mocha';
import type { IAction } from '../../../../../base/common/actions.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import type { IActionListDelegate, IActionListItem } from '../../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService, type NotificationMessage } from '../../../../../platform/notification/common/notification.js';
import { IBrowserViewWorkbenchService } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import type { BrowserEditorInput } from '../../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import type { AgentTreeNode, ISession } from '../../../../services/sessions/common/session.js';
import { SessionBrowsersControl } from '../../browser/sessionBrowsersControl.js';

test('The Sessions browser menu opens only the viewed conversation and its delegated Agent pages', async () => {
	const dom = new JSDOM('<!doctype html><body><textarea></textarea></body>');
	using window = toDisposable(() => dom.window.close());
	using services = new InstantiationService();
	using pagesChanged = new Emitter<void>();
	using contextChanged = new Emitter<void>();
	const usage = { outputTokens: 0, inputTokens: 0 };
	const node = (threadId: string, origin: AgentTreeNode['origin'], children: AgentTreeNode[] = []): AgentTreeNode => ({
		threadId, origin, children, title: threadId, threadSequence: 1, membershipStatus: 'active', executionStatus: 'idle', usage, joins: [],
	});
	const spawned = node('agent', { type: 'agentSpawn', parentThreadId: 'root', parentSequence: 1, delegationId: 'delegation' }, [
		node('nested', { type: 'agentSpawn', parentThreadId: 'agent', parentSequence: 1, delegationId: 'nested-delegation' }),
	]);
	const fork = node('fork', { type: 'fork', parentThreadId: 'root', parentSequence: 1 });
	const session: ISession = { sessionId: 'session', kind: 'code' as const, title: 'Session', status: 'active', nextApprovalMode: 'manual', chats: [], agentTree: [node('root', { type: 'root' }, [spawned, fork])] };
	const context = { session, threadId: 'root', onDidChange: contextChanged.event };
	const pages = new Map(['root', 'agent', 'nested', 'fork', 'other'].map(id => [id, {
		id, label: `Page ${id}`, isDisposed: false,
		model: { info: { owner: { type: 'agent', sessionId: id } }, state: { url: `https://example.test/${id}` } },
	} as unknown as BrowserEditorInput]));
	const opened: { readonly page: string; readonly target: unknown; }[] = [];
	const shown = new DeferredPromise<readonly IActionListItem<IAction>[]>();
	let menu: IActionListDelegate<IAction> | undefined;
	services.registerInstance(IActionWidgetService, {
		show: (_id: string, _preview: boolean, items: readonly IActionListItem<IAction>[], delegate: IActionListDelegate<IAction>) => { menu = delegate; void shown.complete(items); },
		hide: () => { const current = menu; menu = undefined; current?.onHide(); },
	} as unknown as IActionWidgetService);
	services.registerInstance(IBrowserViewWorkbenchService, { getContextualBrowserViews: () => pages, onDidChangeBrowserViews: pagesChanged.event } as unknown as IBrowserViewWorkbenchService);
	services.registerInstance(IEditorGroupsService, { groups: [{ id: 2, inputs: [pages.get('nested')] }] } as unknown as IEditorGroupsService);
	services.registerInstance(IEditorService, { openEditor: async (page, _options, target) => { opened.push({ page: page.label!, target }); } } as IEditorService);
	services.registerInstance(INotificationService, { error: (message: NotificationMessage | NotificationMessage[]) => assert.fail(String(message)) } as unknown as INotificationService);
	const document = dom.window.document;
	const input = document.querySelector('textarea')!;
	using control = services.createInstance(SessionBrowsersControl, document.body, context, () => input.focus());
	const button = document.querySelector('button')!;
	assert.equal(button.getAttribute('aria-label'), 'Browsers (3)');
	button.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
	const items = await shown.p;
	assert.deepEqual(items.map(item => item.label), ['Page root', 'Page agent', 'Page nested']);
	await menu!.onSelect(items[2]!.item!);
	assert.deepEqual(opened, [{ page: 'Page nested', target: { groupId: 2 } }]);
	context.threadId = 'fork';
	contextChanged.fire();
	assert.equal(button.getAttribute('aria-label'), 'Browsers (1)');
	button.focus();
	pages.delete('fork');
	pagesChanged.fire();
	assert.equal(control.isShowing, false);
	assert.equal(document.activeElement, input);
});

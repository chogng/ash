import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { setARIAContainer } from '../../../../../../../../base/browser/ui/aria/aria.js';
import { DeferredPromise } from '../../../../../../../../base/common/async.js';
import { DisposableStore, toDisposable } from '../../../../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../../../../base/common/observable.js';
import { URI } from '../../../../../../../../base/common/uri.js';
import { installEditorTestDom } from '../../../../../../../../editor/test/browser/editorTestGlobals.js';
import { ICommandService } from '../../../../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../../../../platform/instantiation/common/instantiationService.js';
import { AccessibleViewRegistry } from '../../../../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleViewType } from '../../../../../../../../platform/accessibility/browser/accessibleView.js';
import { ChatInputNoticeHost, ChatInputNoticeLane } from '../../../../../browser/widget/input/notices/chatInputNoticeHost.js';
import { ChatInputNotificationWidget } from '../../../../../browser/widget/input/notices/chatInputNotificationWidget.js';
import { ChatInputNotificationActionKind, ChatInputNotificationService, ChatInputNotificationSeverity, IChatInputNotificationService, type IChatInputNotification } from '../../../../../browser/widget/input/notices/chatInputNotificationService.js';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(executeCommand: (id: string, ...args: unknown[]) => Promise<unknown> = async () => undefined) {
	const owner = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	owner.add(toDisposable(() => dom.window.close()));
	owner.add(installEditorTestDom(dom, ['Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'MouseEvent', 'KeyboardEvent']));
	owner.add(setARIAContainer(dom.window.document.body));
	const services = owner.add(new InstantiationService());
	services.registerInstance(ICommandService, { executeCommand } as unknown as ICommandService);
	services.registerSingleton(IChatInputNotificationService, () => services.createInstance(ChatInputNotificationService));
	const notifications = services.get(IChatInputNotificationService);
	const widget = (id: string) => {
		const container = dom.window.document.createElement('main');
		const input = dom.window.document.createElement('textarea');
		container.append(input);
		dom.window.document.body.append(container);
		const host = owner.add(new ChatInputNoticeHost(() => input.focus()));
		const visible = observableValue(owner, true);
		const inputUri = URI.parse(`ash-chat-input:/${id}`);
		const view = owner.add(services.createInstance(ChatInputNotificationWidget, {
			container, inputUri, hostVisible: visible, noticeHost: host,
			focusInput: () => input.focus(), modelSelection: { openPicker: () => { openedModels++; } },
		}));
		return { view, inputUri, visible, host, input };
	};
	let openedModels = 0;
	return { services, notifications, widget, dom, get openedModels() { return openedModels; }, dispose: () => owner.dispose(), [Symbol.dispose]: () => owner.dispose() };
}

function notice(id: string, inputUri?: URI, severity = ChatInputNotificationSeverity.Error): IChatInputNotification {
	return { id, inputUri, severity, message: id, actions: [], dismissible: true, autoDismissOnMessage: true };
}

suite('Chat input notification production widget', () => {
	test('construction rejects an unregistered notification service', () => {
		using f = fixture();
		using missing = new InstantiationService();
		const { view, inputUri, visible, host, input } = f.widget('first');
		assert.throws(() => missing.createInstance(ChatInputNotificationWidget, {
			container: view.domNode.parentElement!, inputUri, hostVisible: visible, noticeHost: host,
			focusInput: () => input.focus(), modelSelection: { openPicker: () => { } },
		}), /chatInputNotificationService/);
	});

	test('an open accessible view receives notification content updates', async () => {
		using f = fixture();
		const { view, inputUri, input } = f.widget('first');
		f.notifications.setNotification(notice('initial', inputUri));
		await flush();
		view.focus();
		using provider = AccessibleViewRegistry.getImplementations()
			.filter(entry => entry.type === AccessibleViewType.View && entry.name.startsWith('chatInputNotice-'))
			.map(entry => entry.getProvider(f.services)).find(candidate => !!candidate)!;
		let changes = 0;
		using listener = provider.onDidChangeContent!(() => changes++);
		f.notifications.setNotification(notice('another input', URI.parse('ash-chat-input:/second')));
		await flush();
		assert.equal(changes, 0);
		f.notifications.setNotification({ ...notice('initial', inputUri), message: 'Updated failure' }, { inPlace: true });
		await flush();
		assert.ok(changes > 0);
		assert.match(provider.provideContent(), /Updated failure/);
		f.notifications.deleteNotification('initial');
		await flush();
		assert.equal(provider.provideContent(), '');
		provider.dispose();
		assert.equal(f.dom.window.document.activeElement, input);
	});

	test('input scoping happens before severity selection and hiding an input releases its lane', async () => {
		using f = fixture();
		const first = f.widget('first');
		const second = f.widget('second');
		f.notifications.setNotification(notice('first warning', first.inputUri, ChatInputNotificationSeverity.Warning));
		f.notifications.setNotification(notice('second error', second.inputUri));
		await flush();
		assert.equal(first.view.domNode.querySelector('p')!.textContent, 'first warning');
		assert.equal(second.view.domNode.querySelector('p')!.textContent, 'second error');
		assert.equal(first.view.domNode.classList.contains('severity-warning'), true);
		first.visible.set(false, undefined);
		assert.equal(first.view.domNode.hidden, true);
		assert.equal(first.host.hasFocusableNotice(), false);
		assert.equal(second.view.domNode.hidden, false);
	});

	test('dismissal and in-place snapshots survive unrelated renders; an explicit replacement reappears', async () => {
		using f = fixture();
		const { view, inputUri, input } = f.widget('first');
		const error = notice('error', inputUri);
		f.notifications.setNotification(error);
		await flush();
		const dismiss = view.domNode.querySelector<HTMLButtonElement>('button')!;
		dismiss.focus();
		dismiss.click();
		await flush();
		assert.equal(view.domNode.hidden, true);
		assert.equal(f.dom.window.document.activeElement, input);
		f.notifications.setNotification({ ...error, description: 'Another model snapshot' }, { inPlace: true });
		await flush();
		assert.equal(view.domNode.hidden, true);
		f.notifications.setNotification(error);
		await flush();
		assert.equal(view.domNode.hidden, false);
	});

	test('a command acknowledgement cannot dismiss a replacement published under the same id', async () => {
		const completed = new DeferredPromise<void>();
		const executed: unknown[][] = [];
		using f = fixture(async (...args) => { executed.push(args); await completed.p; });
		const { view, inputUri } = f.widget('first');
		const original = { ...notice('error', inputUri), actions: [{ kind: ChatInputNotificationActionKind.Command, commandId: 'test.repair', commandArgs: ['captured'], label: 'Repair' }] } as const;
		f.notifications.setNotification(original);
		await flush();
		view.domNode.querySelector<HTMLButtonElement>('button')!.click();
		assert.deepEqual(executed, [['test.repair', 'captured']]);
		const replacement = { ...original, message: 'Replacement error' };
		f.notifications.setNotification(replacement);
		await completed.complete();
		await flush();
		assert.equal(f.notifications.getActiveNotification(), replacement);
		assert.equal(view.domNode.hidden, false);
		assert.equal(view.domNode.querySelector('p')!.textContent, 'Replacement error');
	});

	test('model actions reach the input picker and failed commands keep the visible notice actionable', async () => {
		using f = fixture(async () => { throw new Error('repair denied'); });
		const { view, inputUri } = f.widget('first');
		f.notifications.setNotification({ ...notice('models', inputUri), actions: [{ kind: ChatInputNotificationActionKind.OpenModelPicker, label: 'Choose model' }] });
		await flush();
		view.domNode.querySelector<HTMLButtonElement>('button')!.click();
		await flush();
		assert.equal(f.openedModels, 1);
		assert.equal(view.domNode.hidden, true);
		f.notifications.setNotification({ ...notice('command', inputUri), actions: [{ kind: ChatInputNotificationActionKind.Command, commandId: 'test.repair', label: 'Repair' }] });
		await flush();
		view.domNode.querySelector<HTMLButtonElement>('button')!.click();
		await flush();
		assert.equal(view.domNode.hidden, false);
		assert.match(view.domNode.querySelector('.ash-chat-input-notification-action-error')!.textContent!, /repair denied/);
		assert.equal(view.domNode.querySelector<HTMLButtonElement>('button')!.disabled, false);
	});

	test('message acknowledgement is scoped and does not dismiss another input or a persistent failure', async () => {
		using f = fixture();
		const first = f.widget('first');
		const second = f.widget('second');
		f.notifications.setNotification(notice('first', first.inputUri));
		f.notifications.setNotification(notice('second', second.inputUri));
		const persistent = { ...notice('persistent', first.inputUri), autoDismissOnMessage: false };
		f.notifications.setNotification(persistent);
		f.notifications.handleMessageSent({ inputUri: first.inputUri });
		await flush();
		assert.equal(f.notifications.getActiveNotification(item => item.inputUri === first.inputUri), persistent);
		assert.equal(f.notifications.getActiveNotification(item => item.inputUri === second.inputUri)?.id, 'second');
		f.notifications.deleteNotification('persistent');
		await flush();
		assert.equal(first.view.domNode.hidden, true);
	});

	test('a same-turn error-to-warning replacement never spends a pending introduction showing in between', async () => {
		using f = fixture();
		const { host, inputUri } = f.widget('first');
		f.notifications.setNotification(notice('error', inputUri));
		await flush();
		let introductions = 0;
		using introduction = host.occupy(ChatInputNoticeLane.Onboarding, { onDidChangeLeading: leading => { if (leading) introductions++; } });
		f.notifications.deleteNotification('error');
		f.notifications.setNotification(notice('warning', inputUri, ChatInputNotificationSeverity.Warning));
		await flush();
		assert.equal(introductions, 0);
		f.notifications.deleteNotification('warning');
		await flush();
		assert.equal(introductions, 1);
	});
});

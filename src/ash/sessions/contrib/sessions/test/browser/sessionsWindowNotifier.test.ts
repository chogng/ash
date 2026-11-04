import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import type { IToastOptions, IToastResult } from '../../../../../platform/native/common/native.js';
import { ChatConfiguration, ChatNotificationMode } from '../../../../../workbench/contrib/chat/common/constants.js';
import { IChatSessionNavigationService } from '../../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { IHostService } from '../../../../../workbench/services/host/browser/host.js';
import { productLanguagePackCatalogs } from '../../../../../workbench/services/localization/common/localizationCatalogs.js';
import type { ISession, SessionManagementInfo } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { SessionsWindowNotifier } from '../../browser/sessionsWindowNotifier.js';

function session(status: SessionManagementInfo['status'], time: number): ISession {
	return {
		sessionId: 'ssh/session', title: 'Example session', status: 'active', nextApprovalMode: 'manual',
		chats: [{ threadId: 'ssh/thread', title: 'Branch', status: 'active', origin: { type: 'root' }, management: { status, statusChangedAtUnixMs: time } }],
	};
}

function fixture(initial: ISession) {
	const lifetime = new DisposableStore();
	const changed = lifetime.add(new Emitter<void>());
	const services = lifetime.add(new InstantiationService());
	const pending: { options: IToastOptions; token: CancellationToken; result: DeferredPromise<IToastResult>; }[] = [];
	const opened: string[][] = [];
	const settings = new Map<string, ChatNotificationMode>();
	let sessions = [initial];
	let focused = false;
	services.registerInstance(ISessionsManagementService, {
		get sessions() { return sessions; }, state: 'ready', onDidChange: changed.event,
	} as unknown as ISessionsManagementService);
	services.registerInstance(IHostService, {
		// The renderer can retain DOM focus after the native window loses focus.
		hasFocus: true,
		showToast: (options: IToastOptions, token: CancellationToken) => {
			if (options.onlyWhenUnfocused && focused) return Promise.resolve({ supported: true, clicked: false });
			const result = new DeferredPromise<IToastResult>();
			pending.push({ options, token, result });
			return result.p;
		},
	} as unknown as IHostService);
	services.registerInstance(IConfigurationService, { getValue: (key: string) => settings.get(key) } as IConfigurationService);
	services.registerInstance(IChatSessionNavigationService, {
		openConversation: async (sessionId: string, threadId: string) => { opened.push([sessionId, threadId]); },
	} as IChatSessionNavigationService);
	services.registerInstance(ILogService, { warn: (...args: unknown[]) => assert.fail(String(args)) } as unknown as ILogService);
	lifetime.add(services.createInstance(SessionsWindowNotifier));
	return {
		[Symbol.dispose]: () => lifetime.dispose(),
		pending, opened, settings,
		focus: () => { focused = true; },
		update: (...next: ISession[]) => { sessions = next; changed.fire(); },
	};
}

test('Background completion waits for follow-ups, deduplicates refreshes and opens the exact Thread', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		using value = fixture(session('readyForReview', 1));
		mock.timers.tick(1500);
		assert.equal(value.pending.length, 0);
		value.update(session('working', 2));
		value.update(session('readyForReview', 3));
		mock.timers.tick(1499);
		assert.equal(value.pending.length, 0);
		value.update(session('working', 4));
		mock.timers.tick(1500);
		assert.equal(value.pending.length, 0);
		value.update(session('readyForReview', 5));
		value.update(session('readyForReview', 5));
		mock.timers.tick(1500);
		assert.equal(value.pending.length, 1);
		assert.equal(value.pending[0].options.body, 'Session completed.');
		value.focus();
		await value.pending[0].result.complete({ supported: true, clicked: true });
		assert.deepEqual(value.opened, [['ssh/session', 'ssh/thread']]);
		value.update(session('readyForReview', 5));
		mock.timers.tick(1500);
		assert.equal(value.pending.length, 1);
	} finally { mock.timers.reset(); }
});

test('Input notifications honor modes, use Chinese copy and cancel when their occurrence goes away', async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using value = fixture(session('working', 1));
		value.update(session('needsInput', 2));
		mock.timers.tick(1);
		assert.equal(value.pending[0].options.body, '需要你的输入。');
		await value.pending[0].result.complete({ supported: true, clicked: false });
		value.update(session('working', 3));
		value.focus();
		value.update(session('needsInput', 4));
		mock.timers.tick(1);
		assert.equal(value.pending.length, 1);
		value.settings.set(ChatConfiguration.NotifyWindowOnConfirmation, ChatNotificationMode.Always);
		value.update(session('working', 5));
		value.update(session('needsInput', 6));
		mock.timers.tick(1);
		assert.equal(value.pending[1].options.body, '需要你的输入。');
		assert.equal(value.pending[1].options.title, '会话：Branch');
		value.update();
		assert.equal(value.pending[1].token.isCancellationRequested, true);
		await value.pending[1].result.complete({ supported: true, clicked: true });
		assert.deepEqual(value.opened, []);
		value.update(session('working', 7));
		value.settings.set(ChatConfiguration.NotifyWindowOnConfirmation, ChatNotificationMode.Off);
		value.update(session('needsInput', 8));
		mock.timers.tick(1);
		assert.equal(value.pending.length, 2);
	} finally { resetNlsResolver(); mock.timers.reset(); }
});

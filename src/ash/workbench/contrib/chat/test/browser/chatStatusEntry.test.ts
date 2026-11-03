import '../../../../../editor/test/browser/testEditorDom.js';
import '../../browser/chat.shared.contribution.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { IAccountService, type AccountRateLimits, type AccountState } from '../../../../../platform/accounts/common/accountService.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { StatusbarService } from '../../../../browser/parts/statusbar/statusbarPart.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { ChatEntitlementService, IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { TestNotificationService } from '../../../../services/notification/test/common/testNotificationService.js';
import { IStatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { ChatStatusBarEntry } from '../../browser/chatStatus/chatStatusEntry.js';

afterEach(() => resetNlsResolver());

function setup(resources: DisposableStore) {
	const services = resources.add(new InstantiationService());
	const configuration = resources.add(new InMemoryConfigurationService());
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IChatEntitlementService, services.createInstance(ChatEntitlementService));
	const changes = resources.add(new Emitter<AccountState>());
	let read: () => Promise<AccountState> = async () => ({ revision: 0n, accounts: [] });
	let readLimits: IAccountService['readRateLimits'] = async () => { throw new Error('Unexpected quota query'); };
	services.registerInstance(IAccountService, { readRateLimits: (...args) => readLimits(...args), read: () => read(), onDidChangeAccounts: changes.event } as IAccountService);
	const container = document.createElement('div');
	document.body.append(container);
	resources.add(toDisposable(() => container.remove()));
	const quickInput = resources.add(new TestQuickInputService({ container }));
	services.registerInstance(IQuickInputService, quickInput);
	const statusbar = resources.add(new StatusbarService());
	services.registerInstance(IStatusbarService, statusbar);
	const commands: unknown[][] = [];
	services.registerInstance(ICommandService, { executeCommand: async (...args: unknown[]) => { commands.push(args); } } as unknown as ICommandService);
	services.registerInstance(INotificationService, resources.add(new TestNotificationService()));
	const host = resources.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, [ChatStatusBarEntry.ID]));
	host.advance(WorkbenchPhase.BlockRestore);
	return {
		host, configuration, changes, quickInput, commands,
		entry: () => statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry,
		limitsWith: (reader: typeof readLimits) => { readLimits = reader; },
		readWith: (reader: typeof read) => { read = reader; },
	};
}

const tick = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)); };

for (const locale of ['en', 'zh-CN']) {
	test(`AI status opens existing navigation and releases its picker in ${locale}`, async () => {
		initializeTestLocalization(locale);
		using resources = new DisposableStore();
		const f = setup(resources);
		await f.host.workspaceRestored();
		await tick();
		assert.equal(f.entry()?.text, locale === 'en' ? 'AI · No subscription accounts' : 'AI · 无订阅账号');
		for (const index of [0, 1, 2]) {
			f.entry()!.run!();
			const picker = f.quickInput.currentQuickInput as IQuickPick<IQuickPickItem>;
			assert.equal(picker.items.length, 4);
			assert.equal(picker.items[2].label, locale === 'en' ? 'View Chat Usage' : '查看聊天用量');
			f.entry()!.run!();
			assert.equal(f.quickInput.currentQuickInput, picker);
			picker.activeItems = [picker.items[index] as IQuickPickItem];
			await f.quickInput.accept();
			assert.equal(f.quickInput.currentQuickInput, undefined);
		}
		assert.deepEqual(f.commands, [
			['workbench.action.manageAccounts'], ['workbench.action.chat.manage'],
			['workbench.action.openSettings', { section: 'chat-usage', jsonEditor: false }],
		]);
		f.entry()!.run!();
		await f.configuration.updateValue(ChatAIDisabledSettingId, true);
		assert.equal(f.entry(), undefined);
		assert.equal(f.quickInput.currentQuickInput, undefined);
		await f.configuration.updateValue(ChatAIDisabledSettingId, false);
		assert.ok(f.entry());
		f.entry()!.run!();
		f.host.dispose();
		assert.equal(f.entry(), undefined);
		assert.equal(f.quickInput.currentQuickInput, undefined);
	});
}

test('Account events retire older reads, update open status, and survive a failed read', async () => {
	using resources = new DisposableStore();
	const f = setup(resources);
	let complete!: (value: AccountState) => void;
	f.readWith(() => new Promise(resolve => { complete = resolve; }));
	await f.host.workspaceRestored();
	const state: AccountState = {
		revision: 2n, accounts: [{ provider: 'test', accountId: 'one', displayName: 'Account', status: 'reauthenticationRequired', credentialRevision: 1n }],
	};
	f.changes.fire(state);
	complete({ revision: 1n, accounts: [] });
	await tick();
	assert.equal(f.entry()?.text, 'AI · Accounts need attention');
	f.entry()!.run!();
	const picker = f.quickInput.currentQuickInput as IQuickPick<IQuickPickItem>;
	assert.equal((picker.items[0] as IQuickPickItem).description, 'test · Sign in again');
	f.changes.fire({ ...state, revision: 3n, accounts: [{ ...state.accounts[0], status: 'ready' }] });
	assert.equal(f.entry()?.text, 'AI · Accounts ready');
	assert.equal((picker.items[0] as IQuickPickItem).description, 'test · Signed in');
	await f.quickInput.cancel();
	assert.deepEqual(f.commands, []);
	f.readWith(async () => { throw new Error('disconnected'); });
	f.entry()!.run!();
	await tick();
	assert.equal(f.entry()?.text, 'AI · Account status unavailable');
	f.host.dispose();
	f.changes.fire(state);
	assert.equal(f.entry(), undefined);
});

test('AI status requires its account service through production assembly', () => {
	using services = new InstantiationService();
	using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, [ChatStatusBarEntry.ID]);
	assert.throws(() => host.advance(WorkbenchPhase.BlockRestore), /accountService/);
});

function quota(provider = 'chatgpt-subscription', accountId = 'one'): AccountRateLimits {
	return {
		provider, accountId, plan: 'plus', credits: null, xai: null,
		limits: [{
			id: 'codex', name: 'Codex', model: null, allowed: true, limitReached: false,
			primary: { usedPercent: 25, windowSeconds: 18000, resetsAt: 1800000000 },
			secondary: { usedPercent: 120, windowSeconds: 604800, resetsAt: null }
		}],
	};
}

for (const locale of ['en', 'zh-CN']) {
	test(`Subscription limits show remaining windows, reset times and explicit refresh in ${locale}`, async () => {
		initializeTestLocalization(locale);
		using resources = new DisposableStore();
		const f = setup(resources);
		const state: AccountState = { revision: 1n, accounts: [{ provider: 'chatgpt-subscription', accountId: 'one', status: 'ready', credentialRevision: 1n }] };
		f.readWith(async () => state);
		let queries = 0;
		f.limitsWith(async (provider, accountId) => { queries++; assert.deepEqual([provider, accountId], ['chatgpt-subscription', 'one']); return quota(); });
		await f.host.workspaceRestored();
		await tick();
		assert.equal(queries, 0, 'Quota queries start only when the user opens status');
		f.entry()!.run!();
		await tick();
		const picker = f.quickInput.currentQuickInput as IQuickPick<IQuickPickItem>;
		const windows = picker.items.filter(item => item.label?.includes('Codex')) as IQuickPickItem[];
		assert.equal(windows.length, 2);
		assert.equal(windows[0].description, locale === 'en' ? '75% remaining (25% used)' : '剩余 75%（已用 25%）');
		assert.match(windows[0].detail!, locale === 'en' ? /^Resets: / : /^重置时间：/);
		assert.equal(windows[1].description, locale === 'en' ? '0% remaining (120% used)' : '剩余 0%（已用 120%）');
		assert.equal(windows[1].detail, locale === 'en' ? 'Reset time: not reported' : '重置时间：未报告');
		assert.equal(f.entry()?.text, locale === 'en' ? 'AI · Subscription limit reached' : 'AI · 订阅额度已达上限');
		picker.activeItems = [windows[0]];
		await f.quickInput.accept();
		assert.equal(f.quickInput.currentQuickInput, picker, 'Informational quota rows do not navigate');
		picker.activeItems = [picker.items[picker.items.length - 1] as IQuickPickItem];
		await f.quickInput.accept();
		await tick();
		assert.equal(queries, 2);
		assert.equal(f.quickInput.currentQuickInput, picker);
		assert.deepEqual(f.commands, []);
	});
}

test('Quota failures stay account-local and fractional xAI usage and large USD cents remain exact', async () => {
	using resources = new DisposableStore();
	const f = setup(resources);
	f.readWith(async () => ({ revision: 1n, accounts: ['chatgpt-subscription', 'xai-subscription'].map(provider => ({ provider, accountId: 'one', status: 'ready', credentialRevision: 1n })) }));
	f.limitsWith(async provider => {
		if (provider === 'chatgpt-subscription') { throw new Error('provider offline'); }
		return { ...quota(provider), limits: [], xai: { allowed: true, message: null, usedPercent: 12.125, periodType: null, periodStart: null, periodEnd: '2027-01-01T00:00:00Z', prepaidCents: '9007199254740993', onDemandEnabled: null, onDemandUsedCents: null, onDemandCapCents: null, unifiedBilling: null } };
	});
	await f.host.workspaceRestored();
	await tick();
	f.entry()!.run!();
	await tick();
	const picker = f.quickInput.currentQuickInput as IQuickPick<IQuickPickItem>;
	const descriptions = picker.items.map(item => (item as IQuickPickItem).description);
	assert.ok(descriptions.includes('Could not load limits. Use Refresh to retry.'));
	assert.ok(descriptions.includes('87.875% remaining (12.125% used)'));
	assert.ok(descriptions.includes('USD 90071992547409.93'));
	assert.ok(descriptions.includes('Not reported'));
	assert.equal(picker.busy, false);
});

test('Account changes, closing, disabling AI and disposal retire quota replies', async () => {
	using resources = new DisposableStore();
	const f = setup(resources);
	let state: AccountState = { revision: 1n, accounts: [{ provider: 'chatgpt-subscription', accountId: 'one', status: 'ready', credentialRevision: 1n }] };
	f.readWith(async () => state);
	const pending: { signal: AbortSignal; finish: (result: AccountRateLimits) => void; }[] = [];
	f.limitsWith((_provider, _id, signal) => new Promise(resolve => pending.push({ signal: signal!, finish: resolve })));
	await f.host.workspaceRestored();
	await tick();
	f.entry()!.run!();
	await tick();
	const first = pending[0];
	state = { revision: 2n, accounts: [{ ...state.accounts[0], accountId: 'two', credentialRevision: 2n }] };
	f.changes.fire(state);
	assert.equal(first.signal.aborted, true);
	first.finish(quota());
	await tick();
	const picker = f.quickInput.currentQuickInput as IQuickPick<IQuickPickItem>;
	assert.ok(!picker.items.some(item => (item as IQuickPickItem).description === '0% remaining (120% used)'));
	await f.quickInput.cancel();
	assert.equal(pending[1].signal.aborted, true);
	pending[1].finish(quota('chatgpt-subscription', 'two'));
	await tick();
	assert.equal(f.entry()?.text, 'AI · Accounts ready');
	f.entry()!.run!();
	await tick();
	await f.configuration.updateValue(ChatAIDisabledSettingId, true);
	assert.equal(pending[2].signal.aborted, true);
	pending[2].finish(quota('chatgpt-subscription', 'two'));
	await tick();
	assert.equal(f.entry(), undefined);
	await f.configuration.updateValue(ChatAIDisabledSettingId, false);
	f.entry()!.run!();
	await tick();
	f.host.dispose();
	assert.equal(pending[3].signal.aborted, true);
	pending[3].finish(quota('chatgpt-subscription', 'two'));
	await tick();
	assert.equal(f.entry(), undefined);
});

test('Missing subscription data stays unknown and unlimited credits require an explicit report', async () => {
	using resources = new DisposableStore();
	const f = setup(resources);
	f.readWith(async () => ({ revision: 1n, accounts: [{ provider: 'chatgpt-subscription', accountId: 'one', status: 'ready', credentialRevision: 1n }] }));
	let credits: AccountRateLimits['credits'] = null;
	f.limitsWith(async () => ({ ...quota(), limits: [], credits }));
	await f.host.workspaceRestored();
	await tick();
	f.entry()!.run!();
	await tick();
	const picker = f.quickInput.currentQuickInput as IQuickPick<IQuickPickItem>;
	assert.ok(picker.items.some(item => (item as IQuickPickItem).description === 'Not reported'));
	assert.ok(!picker.items.some(item => (item as IQuickPickItem).description === 'Unlimited'));
	for (const [reported, expected] of [
		[{ hasCredits: true, unlimited: true, balance: null }, 'Unlimited'],
		[{ hasCredits: true, unlimited: false, balance: null }, 'Available; balance not reported'],
		[{ hasCredits: false, unlimited: false, balance: null }, 'No credits available'],
	] as const) {
		credits = reported;
		picker.activeItems = [picker.items[picker.items.length - 1] as IQuickPickItem];
		await f.quickInput.accept();
		await tick();
		assert.ok(picker.items.some(item => (item as IQuickPickItem).description === expected));
	}
});

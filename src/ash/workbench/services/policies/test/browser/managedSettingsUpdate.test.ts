import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { autorun } from '../../../../../base/common/observable.js';
import { GitHubErrorCode } from '../../../../../platform/github/common/githubService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import messages from '../../../../../../../extensions/language-pack-zh-cn/translations/github.json' with { type: 'json' };
import { ManagedSettingsUpdateService } from '../../browser/managedSettingsUpdateService.js';
import { IAccountPolicyService, type AccountPolicyRefreshState } from '../../common/accountPolicyService.js';

test('Compatibility presentation follows backend state without fetching, granting access or inventing an upgrade', () => {
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(ManagedSettingsUpdateService), /Unknown service.*accountPolicyService/);
	using changes = new Emitter<AccountPolicyRefreshState>();
	let state: AccountPolicyRefreshState = { phase: 'failed', failure: GitHubErrorCode.ManagedSettingsUpdateRequired, retainsPolicy: true };
	services.registerInstance(IAccountPolicyService, { get state() { return state; }, onDidChangeState: changes.event, refresh: async () => assert.fail('Presentation must not refresh policy') });
	const service = services.createInstance(ManagedSettingsUpdateService);
	const info = service.updateInfo.get();
	assert.deepEqual(info, {
		title: 'Managed settings compatibility',
		message: 'GitHub rejected this client’s compatibility for managed settings. Contact your administrator.',
		detail: undefined, action: undefined, updateStatus: undefined,
	});
	const visible: boolean[] = [];
	using view = autorun(reader => visible.push(service.updateInfo.read(reader) !== undefined));
	assert.equal(changes.hasListeners(), true);
	for (const phase of ['idle', 'refreshing', 'ready'] as const) {
		state = { phase }; changes.fire(state);
		assert.equal(service.updateInfo.get(), undefined);
	}
	state = { phase: 'failed', failure: GitHubErrorCode.PermissionDenied, retainsPolicy: false }; changes.fire(state);
	assert.equal(service.updateInfo.get(), undefined);
	state = { phase: 'failed', failure: GitHubErrorCode.ManagedSettingsUpdateRequired, retainsPolicy: false }; changes.fire(state);
	assert.deepEqual(service.updateInfo.get(), info);
	assert.deepEqual(visible, [true, false, false, false, false, true]);
	view.dispose();
	assert.equal(changes.hasListeners(), false);
});

test('Compatibility presentation resolves the client language on read', () => {
	using services = new InstantiationService();
	using changes = new Emitter<AccountPolicyRefreshState>();
	services.registerInstance(IAccountPolicyService, { state: { phase: 'failed', failure: GitHubErrorCode.ManagedSettingsUpdateRequired, retainsPolicy: false }, onDidChangeState: changes.event, refresh: async () => assert.fail('Unexpected refresh') });
	const service = services.createInstance(ManagedSettingsUpdateService);
	setNlsMessages('zh-CN', messages);
	try {
		assert.deepEqual(service.updateInfo.get(), {
			title: '托管设置兼容性',
			message: messages.ash['github.settings.managedCompatibility'],
			detail: undefined, action: undefined, updateStatus: undefined,
		});
	} finally { resetNlsResolver(); }
});

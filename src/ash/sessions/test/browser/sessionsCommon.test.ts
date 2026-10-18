import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../base/common/uri.js';
import { observableValue } from '../../../base/common/observable.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../platform/configuration/common/inMemoryConfigurationService.js';
import { getRemoteAuthority, getRemoteWorkspacePath } from '../../../platform/remote/common/remote.js';
import { TelemetryLevel, type ITelemetryService } from '../../../platform/telemetry/common/telemetry.js';
import { ChatLayoutContext, ChatLayoutPresentation, SESSIONS_LAYOUT_SCOPE_SETTING, type IChatLayoutOwner } from '../../common/chatLayout.js';
import { agentHostSessionWorkspaceKey, buildAgentHostSessionWorkspace } from '../../common/agentHostSessionWorkspace.js';
import { sessionWorkspaceUri } from '../../common/sessionWorkspace.js';
import { getSessionApplication } from '../../common/sessionApplication.js';
import { logSessionsInteraction } from '../../common/sessionsTelemetry.js';
import '../../common/sessionConfig.js';

test('layout operations expire across Chat, scope, phone and disposal transitions', async () => {
	using services = new InstantiationService();
	using configuration = new InMemoryConfigurationService();
	services.registerInstance(IConfigurationService, configuration);
	const phone = observableValue('phone', false);
	using presentation = services.createInstance(ChatLayoutPresentation, true, phone);
	const first: IChatLayoutOwner = { sessionResource: URI.parse('ash-session:/one'), chatResource: URI.parse('ash-chat:/first') };
	const owner = observableValue<IChatLayoutOwner | undefined>('owner', first);
	using context = new ChatLayoutContext(presentation, owner);
	assert.equal(context.isCurrent(context.state.get()), false);
	await configuration.updateValue(SESSIONS_LAYOUT_SCOPE_SETTING, 'chat');
	const snapshot = context.state.get();
	assert.equal(context.isCurrent(snapshot), true);
	owner.set({ ...first, chatResource: URI.parse('ash-chat:/second') });
	assert.equal(context.isCurrent(snapshot), false);
	owner.set(first);
	assert.equal(context.isCurrent(snapshot), false, 'returning to the same Chat cannot revive an old operation');
	const returned = context.state.get();
	phone.set(true);
	assert.equal(context.isCurrent(returned), false);
	phone.set(false);
	const desktop = context.state.get();
	presentation.dispose();
	assert.equal(context.isCurrent(desktop), false);
});

test('runtime workspace identities separate containers, hosts and ambiguous path tuples', () => {
	const first = buildAgentHostSessionWorkspace({ type: 'provider', providerId: 'ash.dev-containers', workspace: 'C:\\source\\one', root: '/workspace' })!;
	const second = buildAgentHostSessionWorkspace({ type: 'provider', providerId: 'ash.dev-containers', workspace: 'C:\\source\\two', root: '/workspace' })!;
	assert.notEqual(agentHostSessionWorkspaceKey(first), agentHostSessionWorkspaceKey(second));
	assert.notEqual(agentHostSessionWorkspaceKey({ authorityId: 'a:b', root: 'c' }), agentHostSessionWorkspaceKey({ authorityId: 'a', root: 'b:c' }));
	assert.equal(first.runtime?.workspace, 'C:\\source\\one');
	assert.equal(sessionWorkspaceUri(first).scheme, 'ash-remote');
	assert.notEqual(sessionWorkspaceUri(first).toString(), sessionWorkspaceUri(second).toString());
	assert.equal(URI.parse(sessionWorkspaceUri(first).toString()).path, '/workspace');
	assert.equal(buildAgentHostSessionWorkspace(null), null);
});

test('an SSH host named local retains its remote directory identity', () => {
	const local = buildAgentHostSessionWorkspace({ type: 'local', root: '/workspace' })!;
	const ssh = buildAgentHostSessionWorkspace({ type: 'ssh', host: 'local', root: '/workspace' })!;
	const sameHost = buildAgentHostSessionWorkspace({ type: 'ssh', host: 'LOCAL', root: '/workspace' })!;
	assert.notEqual(agentHostSessionWorkspaceKey(local), agentHostSessionWorkspaceKey(ssh));
	assert.equal(agentHostSessionWorkspaceKey(ssh), agentHostSessionWorkspaceKey(sameHost));
	assert.equal(ssh.authorityId, 'ssh+local');
	const resource = sessionWorkspaceUri(ssh);
	assert.equal(resource.scheme, 'ash-remote');
	assert.equal(getRemoteAuthority(resource)?.host, 'local');
	assert.equal(getRemoteWorkspacePath(resource), '/workspace');
	assert.equal(sessionWorkspaceUri(local).scheme, 'file');
});

test('remote Session directories retain canonical Windows resource paths', () => {
	for (const target of [
		{ type: 'ssh' as const, host: 'build', root: 'C:\\source\\project' },
		{ type: 'provider' as const, providerId: 'runtime', workspace: 'container', root: 'C:\\source\\project' },
	]) {
		const resource = sessionWorkspaceUri(buildAgentHostSessionWorkspace(target)!);
		assert.equal(resource.path, '/C:/source/project');
		assert.equal(getRemoteWorkspacePath(resource), 'C:/source/project');
	}
});

test('application labels preserve unknown identities and explicit names', () => {
	assert.deepEqual(getSessionApplication('ash'), { id: 'ash', label: 'Ash' });
	assert.deepEqual(getSessionApplication('__proto__'), { id: '__proto__', label: '__proto__' });
	assert.deepEqual(getSessionApplication('other', ' My Editor '), { id: 'other', label: 'My Editor' });
});

test('Sessions usage hooks honor host policy and emit only classified control fields', () => {
	const events: unknown[] = [];
	for (const telemetryLevel of [TelemetryLevel.NONE, TelemetryLevel.CRASH, TelemetryLevel.ERROR, TelemetryLevel.USAGE]) {
		const telemetry = { telemetryLevel, publicLog2: (event: string, data: unknown) => events.push({ event, data }) } as unknown as ITelemetryService;
		logSessionsInteraction(telemetry, 'openInVSCode', 'menu');
	}
	assert.deepEqual(events, [{ event: 'ashSessions.interaction', data: { button: 'openInVSCode', source: 'menu' } }]);
});

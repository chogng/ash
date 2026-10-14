import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../base/common/uri.js';
import { observableValue } from '../../../base/common/observable.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../platform/configuration/common/inMemoryConfigurationService.js';
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

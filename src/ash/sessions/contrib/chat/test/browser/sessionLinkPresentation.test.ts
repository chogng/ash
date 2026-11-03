import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { buildOpenSessionLinkUri } from '../../../../../platform/agentHost/common/openSessionLink.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ILinkPresentationService } from '../../../../../platform/dataChannel/common/dataChannel.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { IChatSessionNavigationService } from '../../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { LinkPresentationService } from '../../../../../workbench/services/dataChannel/browser/dataChannelService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../../common/agentHostSessionsProvider.js';
import type { ISession } from '../../../../services/sessions/common/session.js';
import { sessionIdentity, sessionProviderAuthority } from '../../../../services/sessions/common/sessionIdentity.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import '../../browser/openSessionLinkOpener.contribution.js';

test('Conversation link previews follow the matching host catalog for the contribution lifetime', () => {
	using changes = new Emitter<void>();
	using services = new InstantiationService();
	using contexts = new ContextKeyService();
	using links = new LinkPresentationService(contexts);
	const providerId = 'remote';
	const identity = (id: string) => sessionIdentity(providerId, id, LOCAL_AGENT_HOST_PROVIDER_ID);
	let sessions: readonly ISession[] = [{
		providerId, sessionId: identity('same'), title: 'Remote session', status: 'active', nextApprovalMode: 'manual',
		chats: [{ threadId: identity('root'), origin: { type: 'root' }, status: 'active', title: 'Remote chat' }],
	}];
	services.registerInstance(ILinkPresentationService, links);
	services.registerInstance(IOpenerService, { registerOpener: () => toDisposable(() => { }) } as unknown as IOpenerService);
	services.registerInstance(IChatSessionNavigationService, {} as IChatSessionNavigationService);
	services.registerInstance(ISessionsManagementService, { get sessions() { return sessions; }, onDidChange: changes.event } as ISessionsManagementService);
	using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['sessions.openSessionLinkOpener']);
	host.advance(WorkbenchPhase.BlockRestore);

	const resource = buildOpenSessionLinkUri('same', 'root', sessionProviderAuthority(providerId, LOCAL_AGENT_HOST_PROVIDER_ID));
	const rule = links.getLinkPresentationRule(resource)!;
	using remote = links.createLinkPresentationWatcher(rule.id, resource)!;
	using local = links.createLinkPresentationWatcher(rule.id, buildOpenSessionLinkUri('same', 'root', 'local'))!;
	assert.equal(remote.presentation.get()?.title, 'Remote chat');
	assert.equal(local.presentation.get(), undefined);

	sessions = [];
	changes.fire();
	assert.equal(remote.presentation.get(), undefined);
	host.dispose();
	assert.equal(links.getLinkPresentationRule(resource), undefined);
	assert.equal(changes.hasListeners(), false);
});

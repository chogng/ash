import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import type { UriComponents } from '../../../../../../base/common/uri.js';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import {
	AgentsWindowInvitationState,
	type AgentHostEditorUpdate,
	type IAgentHostEditorState,
} from '../../../../../../platform/chat/common/agentsWindowInvitation.js';
import { buildOpenSessionLinkUri } from '../../../../../../platform/agentHost/common/openSessionLink.js';
import { IAppServerApi } from '../../../../../../platform/agentHost/common/appServerApi.js';
import { ChatAIDisabledSettingId } from '../../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ConfigurationRegistry } from '../../../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import type { INativeHostApi, IOpenAgentsWindowOptions } from '../../../../../../platform/native/common/nativeHost.js';
import { INativeHostService } from '../../../../../common/services.js';
import {
	IChatService,
	type Thread,
	type ThreadUpdateEnvelope,
} from '../../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../../services/chat/common/chatSessionNavigationService.js';
import { IHostService } from '../../../../../services/host/browser/host.js';
import { TestNotificationService } from '../../../../../services/notification/test/common/testNotificationService.js';
import { AgentsWindowInvitationContribution } from '../../../electron-browser/agentSessions/agentsWindowInvitation.js';

class Fixture extends Disposable {
	readonly services = this._register(new InstantiationService());
	readonly state = this._register(
		new AgentsWindowInvitationState(() => 86_400_000, {
			editorSessionCount: 0,
			lastShown: undefined,
			agentsWindowSessionCount: 0,
			lastAgentsWindowSessionCreated: undefined,
		}),
	);
	readonly submitted = this._register(
		new Emitter<{ sessionId: string; threadId: string; isNewSession: boolean; requestSequence: number }>(),
	);
	readonly updates = this._register(new Emitter<ThreadUpdateEnvelope>());
	readonly focus = this._register(new Emitter<boolean>());
	readonly connection = this._register(new Emitter<'ready' | 'stopped'>());
	readonly notifications = this._register(new TestNotificationService());
	readonly configuration: InMemoryConfigurationService;
	active = { sessionId: 'session', threadId: 'thread' };
	focused = true;
	status = 'running';
	readError = false;
	reads = 0;
	cleared = 0;
	opened: IOpenAgentsWindowOptions[] = [];
	handoff: Promise<void> | undefined;
	claimGate: DeferredPromise<void> | undefined;
	constructor() {
		super();
		const registry = new ConfigurationRegistry();
		registry.registerConfiguration({
			key: ChatAIDisabledSettingId,
			defaultValue: false,
			parse: value => {
				if (typeof value !== 'boolean') throw new TypeError('Expected boolean');
				return value;
			},
		});
		this.configuration = this._register(new InMemoryConfigurationService(registry));
		this.services.registerInstance(IConfigurationService, this.configuration);
		this.services.registerInstance(INotificationService, this.notifications);
		this.services.registerInstance(IChatService, {
			onDidSubmitRequest: this.submitted.event,
			onDidUpdateThread: this.updates.event,
			onDidChangeSession: Event.None,
			readThread: async (sessionId, threadId) => {
				this.reads++;
				if (this.readError) throw new Error('Controlled missing Thread');
				return {
					thread: {
						sessionId,
						threadId,
						status: 'active',
						turns: [{ status: this.status }],
					} as unknown as Thread,
				};
			},
		} as IChatService);
		this.services.registerInstance(IChatSessionNavigationService, {
			getActiveConversation: () => this.active,
			captureActiveDraft: async () => ({
				draft: { mode: 'agent', text: 'Unsent draft', contexts: [] },
				clear: () => {
					this.cleared++;
				},
			}),
		} as unknown as IChatSessionNavigationService);
		const owner = this;
		this.services.registerInstance(IHostService, {
			get hasFocus() {
				return owner.focused;
			},
			onDidChangeFocus: this.focus.event,
		} as IHostService);
		this.services.registerInstance(IAppServerApi, {
			onConnectionState: (listener: Parameters<IAppServerApi['onConnectionState']>[0]) =>
				this.connection.event(listener),
		} as unknown as IAppServerApi);
		this.services.registerInstance(INativeHostService, {
			getAgentHostEditorState: async () => this.state.getState(),
			onDidChangeAgentHostEditorState: (listener: (state: IAgentHostEditorState) => void) =>
				this.state.onDidChange(listener),
			updateAgentHostEditorState: async (update: AgentHostEditorUpdate) => this.state.update(1, update),
			claimAgentsWindowInvitation: async (resource: UriComponents) => {
				const invitation = this.state.claim(
					1,
					buildOpenSessionLinkUri('session', new URLSearchParams(resource.query).get('threadId')!, 'local'),
				);
				await this.claimGate?.p;
				return invitation;
			},
			markAgentsWindowInvitationShown: async (id: string) => this.state.markShown(1, id),
			releaseAgentsWindowInvitation: async (id: string) => this.state.release(1, id),
			openAgentsWindow: async (options?: IOpenAgentsWindowOptions) => {
				this.opened.push(options!);
				await this.handoff;
			},
		} as unknown as INativeHostApi);
		this._register(this.services.createInstance(AgentsWindowInvitationContribution));
	}
	async submit(): Promise<void> {
		this.submitted.fire({ ...this.active, isNewSession: true, requestSequence: 1 });
		await setImmediate();
	}
	async show(): Promise<void> {
		await this.submit();
		mock.timers.tick(30_000);
		await setImmediate();
	}
}

suite('Desktop Agents invitation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	for (const action of [
		'ack',
		'failure',
		'dismiss',
		'transfer',
		'disable',
		'blur',
		'lateClaim',
		'changedSelection',
	] as const) {
		test(`real contribution preserves ownership through ${action}`, async () => {
			mock.timers.enable({ apis: ['setTimeout'] });
			try {
				using fixture = new Fixture();
				if (action === 'lateClaim') fixture.claimGate = new DeferredPromise<void>();
				await fixture.show();
				if (action === 'lateClaim') {
					fixture.state.update(undefined, {
						kind: 'request',
						resource: buildOpenSessionLinkUri('session', 'thread', 'local').toJSON(),
						isNewSession: false,
						requestSequence: 2,
					});
					await fixture.claimGate!.complete();
					await setImmediate();
					assert.equal(fixture.notifications.model.getNotifications().length, 0);
					assert.equal(fixture.state.getState().lastShown, undefined);
					return;
				}
				const notification = fixture.notifications.model.getNotifications()[0]!;
				assert.ok(notification);
				assert.equal(
					fixture.state.getState().lastShown,
					undefined,
					'inserting notification history is not an impression',
				);
				notification.updateVisibility(true);
				notification.updateVisibility(true);
				assert.deepEqual(fixture.state.getState().lastShown, { timestamp: 86_400_000, editorSessionCount: 1 });
				if (action === 'ack' || action === 'failure') {
					const acknowledged = new DeferredPromise<void>();
					fixture.handoff = acknowledged.p;
					const opening = notification.actions!.primary![0]!.run() as Promise<void>;
					await setImmediate();
					assert.deepEqual(fixture.opened, [
						{
							conversation: { sessionId: 'session', threadId: 'thread' },
							draft: { mode: 'agent', text: 'Unsent draft', contexts: [] },
						},
					]);
					assert.equal(fixture.cleared, 0);
					if (action === 'ack') {
						await acknowledged.complete();
						await opening;
						assert.equal(fixture.cleared, 1);
					} else {
						const rejection = assert.rejects(opening, /Controlled handoff failure/);
						await acknowledged.error(new Error('Controlled handoff failure'));
						await rejection;
						assert.equal(fixture.cleared, 0);
						assert.equal(fixture.notifications.model.getNotifications().length, 1);
						return;
					}
				} else if (action === 'dismiss') fixture.notifications.model.remove(notification.id);
				else if (action === 'transfer')
					fixture.state.update(undefined, {
						kind: 'request',
						resource: buildOpenSessionLinkUri('session', 'thread', 'local').toJSON(),
						isNewSession: false,
						requestSequence: 2,
					});
				else if (action === 'disable') await fixture.configuration.updateValue(ChatAIDisabledSettingId, true);
				else if (action === 'blur') {
					fixture.focused = false;
					fixture.focus.fire(false);
				} else {
					fixture.active = { sessionId: 'different', threadId: 'different' };
					await notification.actions!.primary![0]!.run();
					assert.deepEqual(fixture.opened, []);
				}
				await setImmediate();
				assert.equal(fixture.state.getState().invitation, undefined);
				assert.equal(fixture.notifications.model.getNotifications().length, 0);
			} finally {
				mock.timers.reset();
			}
		});
	}
	for (const status of ['completed', 'waitingForApproval', 'waitingForUserInput', 'waitingForCapability']) {
		test(`no invitation for ${status}`, async () => {
			mock.timers.enable({ apis: ['setTimeout'] });
			try {
				using fixture = new Fixture();
				fixture.status = status;
				await fixture.show();
				assert.deepEqual(fixture.notifications.model.getNotifications(), []);
				assert.equal(fixture.state.getState().invitation, undefined);
			} finally {
				mock.timers.reset();
			}
		});
	}
	test('streaming deltas do not read activity and a burst of durable invalidations coalesces', async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			using fixture = new Fixture();
			await fixture.submit();
			assert.equal(fixture.reads, 1);
			for (let index = 0; index < 50; index++)
				fixture.updates.fire({
					sessionId: 'session',
					threadId: 'thread',
					durableSequence: 1,
					update: {
						type: 'itemDelta',
						itemId: 'item',
						delta: { type: 'agentMessage', text: 'Synthetic delta' },
					},
				});
			await setImmediate();
			assert.equal(fixture.reads, 1);
			fixture.status = 'completed';
			for (let index = 0; index < 20; index++)
				fixture.updates.fire({
					sessionId: 'session',
					threadId: 'thread',
					durableSequence: 2,
					update: { type: 'committed', event: { type: 'turnCompleted', turnId: 'turn' } },
				});
			await setImmediate();
			assert.equal(fixture.reads, 2);
			assert.equal(fixture.state.getState().sessions[0]?.inProgress, false);
		} finally {
			mock.timers.reset();
		}
	});
	test('a retired connection cancels pending activity and delayed invitations', async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		try {
			using fixture = new Fixture();
			await fixture.submit();
			fixture.connection.fire('stopped');
			await setImmediate();
			mock.timers.tick(30_000);
			await setImmediate();
			assert.deepEqual(fixture.notifications.model.getNotifications(), []);
			assert.equal(fixture.state.getState().sessions[0]?.inProgress, false);
		} finally {
			mock.timers.reset();
		}
	});
});

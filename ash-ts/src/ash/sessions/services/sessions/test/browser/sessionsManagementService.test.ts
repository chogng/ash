import assert from "node:assert/strict";
import { test } from "mocha";
import type { AgentTreeNodeProjection, ModelUsageSummary, ServerNotification, Session as SessionDto, SessionThreadProjection } from "../../../../../platform/app-server/common/generated/index.js";
import type { IServerEventApi } from "../../../../../platform/app-server/common/appServerApi.js";
import type { ISessionApi, ITurnApi } from "../../../../../platform/sessions/common/sessionApi.js";
import { AppServerSessionsManagementService } from "../../browser/appServerSessionsManagementService.js";
import { AppServerSessionsProvider } from "../../browser/appServerSessionsProvider.js";

test("management initializes the catalog from provider-owned Session mapping", async () => {
	const fake = sessionHost([session("session-1", "thread-1")]);
	using service = new AppServerSessionsManagementService(new AppServerSessionsProvider(fake.host));

	await service.initialize();

	assert.equal(service.sessions.length, 1);
	assert.equal(service.active?.session.sessionId, "session-1");
	assert.equal(service.active?.threadId, "thread-1");
	assert.equal(service.sessions[0]?.chats[0]?.origin.type, "root");
});

test("opening a background-created conversation reads and subscribes it without reloading the window", async () => {
	const fake = sessionHost([]);
	using service = new AppServerSessionsManagementService(new AppServerSessionsProvider(fake.host));
	await service.initialize();
	fake.sessions.push(session("automation-session", "automation-thread"));

	await service.openThread("automation-session", "automation-thread");

	assert.equal(service.active?.threadId, "automation-thread");
	assert.equal(service.sessions.length, 1);
	assert.equal(fake.subscribeCount, 1);
});

test("session/changed adds a conversation created by another client without changing selection", async () => {
	const fake = sessionHost([session("session-1", "thread-1")]);
	using service = new AppServerSessionsManagementService(new AppServerSessionsProvider(fake.host));
	await service.initialize();
	fake.sessions.push(session("automation-session", "automation-thread"));
	fake.emit({ method: "session/changed", params: { sessionId: "automation-session" } });
	await waitFor(() => service.sessions.length === 2);

	assert.equal(service.sessions[0]?.sessionId, "automation-session");
	assert.equal(service.active?.threadId, "thread-1");
});

test("session/changed invalidates the frontend Session without inventing a Session sequence", async () => {
	const fake = sessionHost([session("session-1", "thread-1")]);
	using service = new AppServerSessionsManagementService(new AppServerSessionsProvider(fake.host));
	await service.initialize();
	const subscriptions = fake.subscribeCount;

	fake.sessions[0] = { ...fake.sessions[0]!, title: "Renamed" };
	fake.emit({ method: "session/changed", params: { sessionId: "session-1" } });
	await waitFor(() => service.sessions[0]?.title === "Renamed");

	assert.equal(fake.subscribeCount, subscriptions + 1);
	assert.equal(service.sessions[0]?.title, "Renamed");
});

test("Thread updates refresh the owning Session while Thread sequence stays on the Chat", async () => {
	const fake = sessionHost([session("session-1", "thread-1")]);
	using service = new AppServerSessionsManagementService(new AppServerSessionsProvider(fake.host));
	await service.initialize();
	const subscriptions = fake.subscribeCount;

	fake.emit({
		method: "session/thread/update",
		params: {
			sessionId: "session-1",
			threadId: "thread-1",
			durableSequence: 3,
			update: { type: "committed", event: { type: "threadArchived", threadId: "thread-1", reason: "completed" } },
		},
	});
	await waitFor(() => fake.subscribeCount === subscriptions + 1);

	assert.equal(service.sessions[0]?.sessionId, "session-1");
	assert.equal(service.sessions[0]?.chats[0]?.threadId, "thread-1");
});

test("archive sends only the Session grouping identity", async () => {
	const fake = sessionHost([session("session-1", "thread-1"), session("session-2", "thread-2")]);
	using service = new AppServerSessionsManagementService(new AppServerSessionsProvider(fake.host));
	await service.initialize();

	await service.archiveSession("session-1");

	assert.deepEqual(fake.archiveRequests, [{ commandId: fake.archiveRequests[0]?.commandId, sessionId: "session-1" }]);
	assert.equal(service.sessions.find(candidate => candidate.sessionId === "session-1")?.status, "archived");
	assert.equal(service.active?.session.sessionId, "session-2");
});

test("interrupt uses the selected Thread sequence from the provider snapshot", async () => {
	const tree = agentNode();
	const fake = sessionHost([session("session-1", "thread-1")], tree);
	using service = new AppServerSessionsManagementService(new AppServerSessionsProvider(fake.host));
	await service.initialize();

	await service.interruptThread("session-1", "thread-1");

	assert.deepEqual(fake.interruptRequests.map(({ sessionId, threadId, turnId, expectedSequence }) => ({ sessionId, threadId, turnId, expectedSequence })), [{
		sessionId: "session-1",
		threadId: "thread-1",
		turnId: "turn-1",
		expectedSequence: 7,
	}]);
});

function session(sessionId: string, threadId: string): SessionDto {
	return {
		sessionId,
		title: `Session ${sessionId}`,
		status: "active",
		manager: { status: "idle", statusChangedAtUnixMs: 0 },
		threads: [{
			threadId,
			title: `Thread ${threadId}`,
			createdAtUnixMs: 0,
			completedTurnDurationMs: 0,
			usage: emptyUsage(),
			status: "active",
		}],
	};
}

function emptyUsage(): ModelUsageSummary {
	const total = { reported: 0, complete: true };
	return { modelInvocations: 0, inputTokens: total, outputTokens: total, cachedInputTokens: total, cacheWriteInputTokens: total, reasoningTokens: total };
}

function agentNode(): AgentTreeNodeProjection {
	const total = { reported: 0, complete: true };
	return {
		threadId: "thread-1",
		threadSequence: 7,
		title: "Main",
		executionStatus: "running",
		currentTurnId: "turn-1",
		usage: {
			modelInvocations: 0,
			inputTokens: total,
			outputTokens: total,
			cachedInputTokens: total,
			cacheWriteInputTokens: total,
			reasoningTokens: total,
		},
		children: [],
	};
}

function sessionHost(initial: SessionDto[], tree?: AgentTreeNodeProjection) {
	const listeners = new Set<(event: ServerNotification) => void>();
	const sessions = [...initial];
	const agentTree = { roots: tree ? [tree] : [] };
	const archiveRequests: Parameters<ISessionApi["archive"]>[0][] = [];
	const interruptRequests: Parameters<ITurnApi["interrupt"]>[0][] = [];
	let subscribeCount = 0;
	const api: ISessionApi = {
		async create() { throw new Error("Not used"); },
		async read({ sessionId }) { return { session: sessions.find(candidate => candidate.sessionId === sessionId)!, agentTree }; },
		async list() { return { sessions }; },
		async subscribe({ sessionId }) {
			subscribeCount += 1;
			const value = sessions.find(candidate => candidate.sessionId === sessionId)!;
			return {
				session: value,
				threadProjections: value.threads.map(thread => threadProjection(sessionId, thread.threadId)),
				agentTree,
			};
		},
		async unsubscribe() {},
		async createThread() { throw new Error("Not used"); },
		async forkThread() { throw new Error("Not used"); },
		async archive(params) {
			archiveRequests.push(params);
			const index = sessions.findIndex(candidate => candidate.sessionId === params.sessionId);
			sessions[index] = { ...sessions[index]!, status: "archived" };
			return { session: sessions[index]!, agentTree };
		},
		async stop() { throw new Error("Not used"); },
	};
	const turn: ITurnApi = {
		async start() { throw new Error("Not used"); },
		async compact() { throw new Error("Not used"); },
		async steer() { throw new Error("Not used"); },
		async interrupt(params) {
			interruptRequests.push(params);
			return { threadId: params.threadId, sequence: params.expectedSequence + 1, turnId: params.turnId };
		},
		async resolveInteraction() { throw new Error("Not used"); },
	};
	const events: IServerEventApi = {
		subscribe(listener) {
			listeners.add(listener);
			return { dispose: () => listeners.delete(listener) };
		},
	};
	return {
		host: { session: api, turn, events },
		sessions,
		archiveRequests,
		interruptRequests,
		get subscribeCount() { return subscribeCount; },
		emit(event: ServerNotification) { for (const listener of listeners) listener(event); },
	};
}

function threadProjection(sessionId: string, threadId: string): SessionThreadProjection {
	return {
		thread: {
			agentId: "agent-1",
			origin: { type: "root" },
			referenceCost: { knownAmounts: [], complete: true },
			sessionId,
			threadId,
			title: "Main",
			status: "active",
			sequence: 1,
			usage: {
				modelInvocations: 0,
				inputTokens: { reported: 0, complete: true },
				outputTokens: { reported: 0, complete: true },
				cachedInputTokens: { reported: 0, complete: true },
				cacheWriteInputTokens: { reported: 0, complete: true },
				reasoningTokens: { reported: 0, complete: true },
			},
			turns: [],
		},
		transcript: { sessionId, threadId, durableSequence: 1, revision: 0, entries: [] },
		updates: [],
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let index = 0; index < 50; index += 1) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	throw new Error("Condition was not met");
}

import type { AppServerProtocolClient } from "../../app-server/browser/appServerProtocolClient.js";
import { appServerRequest, voidResult } from "../../app-server/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import { sessionRequest, sessionResult, sessionThreadResult, turnInteractionResolveResult, turnInterruptResult, turnStartResult, turnSteerResult } from "../common/sessionApi.js";
import type { IModelApi, ISessionApi, IThreadApi, ITurnApi } from "../common/sessionApi.js";

export function createDisconnectedSessionApi(unavailable: UnavailableOperation): ISessionApi {
	return {
		create: () => unavailable("session.create"),
		read: () => unavailable("session.read"),
		readCatalog: () => unavailable("session.readCatalog"),
		list: () => unavailable("session.list"),
		subscribeCatalog: () => unavailable("session.subscribeCatalog"),
		unsubscribeCatalog: () => unavailable("session.unsubscribeCatalog"),
		subscribe: () => unavailable("session.subscribe"),
		unsubscribe: () => unavailable("session.unsubscribe"),
		createThread: () => unavailable("session.createThread"),
		forkThread: () => unavailable("session.forkThread"),
		archive: () => unavailable("session.archive"),
		stop: () => unavailable("session.stop"),
	};
}

export function createDisconnectedModelApi(unavailable: UnavailableOperation): IModelApi {
	return {
		list: () => unavailable("model.list"),
		readModel: () => unavailable("model.readModel"),
		readAdvisorDefault: () => unavailable("model.readAdvisorDefault"),
		readConfiguredProviderIds: () => unavailable("model.readConfiguredProviderIds"),
		setAdvisorDefault: () => unavailable("model.setAdvisorDefault"),
		setModel: () => unavailable("model.setModel"),
	};
}

export function createDisconnectedThreadApi(unavailable: UnavailableOperation): IThreadApi {
	return {
		read: () => unavailable("thread.read"),
		configureAdvisor: () => unavailable("thread.configureAdvisor"),
		subscribe: () => unavailable("thread.subscribe"),
		unsubscribe: () => unavailable("thread.unsubscribe"),
		getGoal: () => unavailable("thread.goal.get"),
		setGoal: () => unavailable("thread.goal.set"),
		clearGoal: () => unavailable("thread.goal.clear"),
	};
}

export function createDisconnectedTurnApi(unavailable: UnavailableOperation): ITurnApi {
	return {
		start: () => unavailable("turn.start"),
		compact: () => unavailable("turn.compact"),
		consultAdvisor: () => unavailable("turn.consultAdvisor"),
		steer: () => unavailable("turn.steer"),
		interrupt: () => unavailable("turn.interrupt"),
		resolveInteraction: () => unavailable("turn.resolveInteraction"),
	};
}

export function createAppServerSessionApi(connection: AppServerProtocolClient): ISessionApi {
	return {
		create: (params) => appServerRequest(connection, "session/create", params),
		read: (params) => appServerRequest(connection, "session/read", params),
		readCatalog: (params) => appServerRequest(connection, "session/catalog/read", params),
		list: () => appServerRequest(connection, "session/list", {}),
		subscribeCatalog: () => appServerRequest(connection, "session/catalog/subscribe", {}),
		unsubscribeCatalog: () => voidResult(appServerRequest(connection, "session/catalog/unsubscribe", {})),
		subscribe: (params) => appServerRequest(connection, "session/subscribe", params),
		unsubscribe: (params) => voidResult(appServerRequest(connection, "session/unsubscribe", params)),
		createThread: (params) => appServerRequest(connection, "session/request", sessionRequest(params, { type: "createThread", title: params.title })).then(sessionThreadResult),
		forkThread: (params) => appServerRequest(connection, "session/request", sessionRequest(params, { type: "forkThread", parentThreadId: params.parentThreadId, title: params.title })).then(sessionThreadResult),
		archive: (params) => appServerRequest(connection, "session/request", sessionRequest(params, { type: "archive" })).then(sessionResult),
		stop: (params) => appServerRequest(connection, "session/request", sessionRequest(params, { type: "stop" })).then(sessionResult),
	};
}

export function createAppServerModelApi(connection: AppServerProtocolClient): IModelApi {
	return {
		list: () => appServerRequest(connection, "model/list", {}),
		readModel: async () => (await appServerRequest(connection, "config/read", {})).model,
		readAdvisorDefault: async () => (await appServerRequest(connection, "config/read", {})).advisor ?? null,
		readConfiguredProviderIds: async () => Object.keys((await appServerRequest(connection, "config/read", {})).providers),
		setAdvisorDefault: async ({ commandId, advisor }) => {
			const config = await appServerRequest(connection, "config/read", {});
			await appServerRequest(connection, "config/update", { commandId, expectedRevision: config.revision, advisor });
		},
		setModel: async ({ commandId, model }) => {
			const config = await appServerRequest(connection, "config/read", {});
			await appServerRequest(connection, "config/update", {
				commandId,
				expectedRevision: config.revision,
				model,
			});
		},
	};
}

export function createAppServerThreadApi(connection: AppServerProtocolClient): IThreadApi {
	return {
		read: (params) => appServerRequest(connection, "session/thread/read", params),
		configureAdvisor: async (params) => {
			const result = await appServerRequest(connection, "session/request", sessionRequest(params, { type: "configureAdvisor", threadId: params.threadId, expectedSequence: params.expectedSequence, selection: params.selection }));
			if (result.type !== "advisorConfigured") throw new Error(`Expected advisor configuration result, received ${result.type}.`);
			return result.value;
		},
		subscribe: (params) => appServerRequest(connection, "session/thread/subscribe", params),
		unsubscribe: (params) => voidResult(appServerRequest(connection, "session/thread/unsubscribe", params)),
		getGoal: (params) => appServerRequest(connection, "thread/goal/get", params),
		setGoal: (params) => appServerRequest(connection, "thread/goal/set", params),
		clearGoal: (params) => appServerRequest(connection, "thread/goal/clear", params),
	};
}

export function createAppServerTurnApi(connection: AppServerProtocolClient): ITurnApi {
	return {
		start: (params) => appServerRequest(connection, "session/request", sessionRequest(params, { type: "startTurn", threadId: params.threadId, expectedSequence: params.expectedSequence, approvalMode: params.approvalMode, toolMode: params.toolMode, input: params.input })).then(turnStartResult),
		consultAdvisor: (params) => appServerRequest(connection, "session/request", sessionRequest(params, { type: "consultAdvisor", threadId: params.threadId, expectedSequence: params.expectedSequence, question: params.question })).then(turnStartResult),
		compact: (params) => appServerRequest(connection, "session/request", sessionRequest(params, { type: "compactContext", threadId: params.threadId, expectedSequence: params.expectedSequence, retentionPrompt: params.retentionPrompt })).then(turnStartResult),
		steer: (params) => appServerRequest(connection, "session/request", sessionRequest(params, { type: "steerTurn", threadId: params.threadId, expectedSequence: params.expectedSequence, turnId: params.turnId, input: params.input })).then(turnSteerResult),
		interrupt: (params) => appServerRequest(connection, "session/request", sessionRequest(params, { type: "interruptTurn", threadId: params.threadId, expectedSequence: params.expectedSequence, turnId: params.turnId })).then(turnInterruptResult),
		resolveInteraction: (params) => appServerRequest(connection, "session/request", sessionRequest(params, { type: "resolveInteraction", threadId: params.threadId, expectedSequence: params.expectedSequence, turnId: params.turnId, requestId: params.requestId, response: params.response })).then(turnInteractionResolveResult),
	};
}

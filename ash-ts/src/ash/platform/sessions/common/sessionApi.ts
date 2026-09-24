import type { AdvisorConfig, AdvisorConfigureResult, ModelListResult, ModelRef, SessionCatalogReadResult, SessionCreateParams, SessionListResult, SessionReadParams, SessionRequest, SessionRequestParams, SessionRequestResult, SessionResult, SessionSubscribeParams, SessionSubscribeResult, SessionThreadReadParams, SessionThreadReadResult, SessionThreadResult, SessionThreadSubscribeParams, SessionThreadSubscribeResult, SessionThreadUnsubscribeParams, SessionUnsubscribeParams, ThreadGoalClearParams, ThreadGoalClearResponse, ThreadGoalGetParams, ThreadGoalGetResponse, ThreadGoalSetParams, ThreadGoalSetResponse, TurnInteractionResolveResult, TurnInterruptResult, TurnStartResult, TurnSteerResult } from "../../app-server/common/generated/index.js";

export type { SessionRequestResult };

export type SessionMutationParams = Omit<SessionRequestParams, "request">;
export type SessionOperationInput<T extends SessionRequest["type"]> = SessionMutationParams & Omit<Extract<SessionRequest, { type: T }>, "type">;

export function sessionRequest(params: SessionMutationParams, request: SessionRequest): SessionRequestParams {
	return { ...params, request };
}

export function sessionResult(result: SessionRequestResult): SessionResult {
	if (result.type !== "session") throw new Error(`Expected Session result, received ${result.type}.`);
	return result.value;
}

export function sessionThreadResult(result: SessionRequestResult): SessionThreadResult {
	if (result.type !== "thread") throw new Error(`Expected Thread result, received ${result.type}.`);
	return result.value;
}

export function turnStartResult(result: SessionRequestResult): TurnStartResult {
	if (result.type !== "turn") throw new Error(`Expected Turn result, received ${result.type}.`);
	return result.value;
}

export function turnInterruptResult(result: SessionRequestResult): TurnInterruptResult {
	if (result.type !== "turnInterrupt") throw new Error(`Expected Turn interrupt result, received ${result.type}.`);
	return result.value;
}

export function turnSteerResult(result: SessionRequestResult): TurnSteerResult {
	if (result.type !== "turnSteer") throw new Error(`Expected Turn steer result, received ${result.type}.`);
	return result.value;
}

export function turnInteractionResolveResult(result: SessionRequestResult): TurnInteractionResolveResult {
	if (result.type !== "interaction") throw new Error(`Expected interaction result, received ${result.type}.`);
	return result.value;
}

export interface ISessionApi {
	create(params: SessionCreateParams): Promise<SessionResult>;
	read(params: SessionReadParams): Promise<SessionResult>;
	readCatalog(params: SessionReadParams): Promise<SessionCatalogReadResult>;
	list(): Promise<SessionListResult>;
	subscribeCatalog(): Promise<SessionListResult>;
	unsubscribeCatalog(): Promise<void>;
	subscribe(params: SessionSubscribeParams): Promise<SessionSubscribeResult>;
	unsubscribe(params: SessionUnsubscribeParams): Promise<void>;
	createThread(params: SessionOperationInput<"createThread">): Promise<SessionThreadResult>;
	forkThread(params: SessionOperationInput<"forkThread">): Promise<SessionThreadResult>;
	archive(params: SessionOperationInput<"archive">): Promise<SessionResult>;
	stop(params: SessionOperationInput<"stop">): Promise<SessionResult>;
}

export interface IModelApi {
	readAdvisorDefault(): Promise<AdvisorConfig | null>;
	readConfiguredProviderIds(): Promise<readonly string[]>;
	setAdvisorDefault(params: { readonly commandId: string; readonly advisor: AdvisorConfig | null }): Promise<void>;
	list(): Promise<ModelListResult>;
	readModel(): Promise<ModelRef | null>;
	setModel(params: { readonly commandId: string; readonly model: ModelRef }): Promise<void>;
}

export interface IThreadApi {
	configureAdvisor(params: SessionOperationInput<"configureAdvisor">): Promise<AdvisorConfigureResult>;
	read(params: SessionThreadReadParams): Promise<SessionThreadReadResult>;
	subscribe(params: SessionThreadSubscribeParams): Promise<SessionThreadSubscribeResult>;
	unsubscribe(params: SessionThreadUnsubscribeParams): Promise<void>;
	getGoal(params: ThreadGoalGetParams): Promise<ThreadGoalGetResponse>;
	setGoal(params: ThreadGoalSetParams): Promise<ThreadGoalSetResponse>;
	clearGoal(params: ThreadGoalClearParams): Promise<ThreadGoalClearResponse>;
}

export interface ITurnApi {
	consultAdvisor(params: SessionOperationInput<"consultAdvisor">): Promise<TurnStartResult>;
	start(params: SessionOperationInput<"startTurn">): Promise<TurnStartResult>;
	compact(params: SessionOperationInput<"compactContext">): Promise<TurnStartResult>;
	steer(params: SessionOperationInput<"steerTurn">): Promise<TurnSteerResult>;
	interrupt(params: SessionOperationInput<"interruptTurn">): Promise<TurnInterruptResult>;
	resolveInteraction(params: SessionOperationInput<"resolveInteraction">): Promise<TurnInteractionResolveResult>;
}

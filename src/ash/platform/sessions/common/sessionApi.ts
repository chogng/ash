import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { AdvisorConfig, AdvisorConfigureResult, CollaborationMode, AgentRoleListResult, ModelListResult, ModelRef, SessionCatalogReadResult, SessionCreateParams, SessionListResult, SessionReadParams, SessionRequest, SessionRequestParams, SessionRequestResult, SessionResult, SessionSubscribeParams, SessionSubscribeResult, SessionThreadReadParams, SessionThreadReadResult, SessionThreadResult, SessionThreadSubscribeParams, SessionThreadSubscribeResult, SessionThreadUnsubscribeParams, SessionUnsubscribeParams, ThreadGoalClearParams, ThreadGoalClearResponse, ThreadGoalGetParams, ThreadGoalGetResponse, ThreadGoalSetParams, ThreadGoalSetResponse, TurnInteractionResolveResult, TurnInterruptResult, TurnStartResult, TurnSteerResult } from "../../../../../crates/app-server-protocol/schema/typescript/index.js";
import type { ProviderApiKeySetParams, ProviderApiKeySetResult, ProviderListResult } from '../../../../../crates/app-server-protocol/schema/typescript/index.js';
import type { ReasoningEffort } from '../../../../../crates/app-server-protocol/schema/typescript/index.js';
import type { QueueEnqueueParams, QueueListParams, QueueListResult, QueuedMessage } from '../../../../../crates/app-server-protocol/schema/typescript/index.js';

export type SessionMode = CollaborationMode;

export type { SessionRequestResult };

export type SessionMutationParams = Omit<SessionRequestParams, "request">;
export type SessionOperationInput<T extends SessionRequest["type"]> = SessionMutationParams & Omit<Extract<SessionRequest, { type: T; }>, "type">;

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
	listAgents(): Promise<AgentRoleListResult>;
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

type ProviderModelCatalogEntry = ModelListResult['models'][number];

export type ModelProviderApiFormat = 'responses' | 'chatCompletions' | 'anthropicMessages';

/** User-owned connection declarations; credentials remain in the secret store. */
export interface CustomModelProvider {
	readonly id: string;
	readonly name: string;
	readonly baseUrl: string;
	readonly apiFormat: ModelProviderApiFormat;
	readonly order: number;
	readonly models: readonly { readonly id: string; readonly contextWindow: number; readonly upstreamModel?: string; }[];
}

export type ModelProviderTestResult = { readonly type: 'passed'; } | { readonly type: 'failed'; readonly message: string; };

export interface ModelPreferencesUpdate {
	readonly acceleration?: string | null;
	readonly longContext?: boolean;
}

/** Review selection does not change the model or effort used by the Agent. */
export type ApprovalReviewModelSelection =
	| { readonly type: 'automatic'; }
	| { readonly type: 'explicit'; readonly model: { readonly provider: string; readonly model: string; }; readonly connection?: string; readonly reasoningEffort?: ReasoningEffort; };

export interface IModelApi {
	readApprovalReviewModel(): Promise<ApprovalReviewModelSelection>;
	setApprovalReviewModel(selection: ApprovalReviewModelSelection): Promise<void>;
	setModelPreferences(model: ModelRef, update: ModelPreferencesUpdate): Promise<void>;
	readAdvisorDefault(): Promise<AdvisorConfig | null>;
	readConfiguredProviderIds(): Promise<readonly string[]>;
	setAdvisorDefault(params: { readonly commandId: string; readonly advisor: AdvisorConfig | null; }): Promise<void>;
	listCustomProviders(): Promise<readonly CustomModelProvider[]>;
	saveCustomProvider(provider: CustomModelProvider): Promise<void>;
	testProviderModel(provider: CustomModelProvider, model: string): Promise<ModelProviderTestResult>;
	listModels(): Promise<ModelListResult>;
	listProviders(): Promise<ProviderListResult>;
	listProviderModels(connection: string): Promise<readonly ProviderModelCatalogEntry[]>;
	setProviderApiKey(params: ProviderApiKeySetParams): Promise<ProviderApiKeySetResult>;
	removeProviderApiKey(connection: string): Promise<void>;
	readModel(): Promise<ModelRef | null>;
	setModel(params: { readonly commandId: string; readonly model: ModelRef; }): Promise<void>;
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
	enqueue(params: QueueEnqueueParams): Promise<QueuedMessage>;
	listQueued(params: QueueListParams): Promise<QueueListResult>;
	consultAdvisor(params: SessionOperationInput<"consultAdvisor">): Promise<TurnStartResult>;
	start(params: SessionOperationInput<"startTurn">): Promise<TurnStartResult>;
	compact(params: SessionOperationInput<"compactContext">): Promise<TurnStartResult>;
	steer(params: SessionOperationInput<"steerTurn">): Promise<TurnSteerResult>;
	interrupt(params: SessionOperationInput<"interruptTurn">): Promise<TurnInterruptResult>;
	resolveInteraction(params: SessionOperationInput<"resolveInteraction">): Promise<TurnInteractionResolveResult>;
}

export const IModelApi = createServiceIdentifier<IModelApi>('ModelApi');

import type { PlanUpdate, ThreadItem, ThreadTranscriptEntry, Turn, TurnError } from "../../../../services/chat/common/chatService.js";

export type ChatTurnErrorAction =
	| { readonly type: "retry"; readonly label: string; readonly turnId: string }
	| { readonly type: "chooseModel"; readonly label: string }
	| { readonly type: "startNewChat"; readonly label: string }
	| { readonly type: "revise"; readonly label: string };

interface ChatTurnErrorListItemOptions {
	readonly actionsEnabled?: boolean;
}

/** One render-ready committed or transient Thread item. */
export interface IChatListItem {
	readonly id: string;
	readonly type: ThreadItem["type"] | "turnError" | "advisor";
	readonly text: string;
	readonly transient: boolean;
	readonly isError?: boolean;
	readonly label?: string;
	readonly detail?: string;
	readonly errorCode?: TurnError["code"];
	readonly action?: ChatTurnErrorAction;
}

/** Projects the canonical durable plan owned by a Turn. */
export function chatPlanListItem(turn: Turn): IChatListItem | undefined {
	if (!turn.plan) return undefined;
	return chatPlanUpdateListItem(turn.turnId, turn.plan);
}

function chatPlanUpdateListItem(turnId: string, plan: PlanUpdate): IChatListItem {
	const steps = plan.steps.map((step) => {
		switch (step.status) {
			case "completed": return `- [x] ${step.step}`;
			case "inProgress": return `- [ ] **In progress:** ${step.step}`;
			case "pending": return `- [ ] ${step.step}`;
		}
	});
	return {
		id: `turn-plan:${turnId}`,
		type: "plan",
		text: [plan.explanation, ...steps].filter((value): value is string => Boolean(value)).join("\n\n"),
		transient: false,
	};
}

/** Groups an advisor call and its result into one inspectable consultation. */
export function chatTranscriptListItems(entries: readonly ThreadTranscriptEntry[], latestTurnId?: string): readonly IChatListItem[] {
	const calls = new Map(entries.flatMap(entry => entry.type === "item" && entry.item.type === "toolCall" && entry.item.name === "advisor" ? [[entry.item.toolCallId, entry] as const] : []));
	const results = new Set(entries.flatMap(entry => entry.type === "item" && entry.item.type === "toolResult" ? [entry.item.toolCallId] : []));
	return entries.flatMap(entry => {
		if (entry.type === "item" && entry.item.type === "toolCall" && calls.has(entry.item.toolCallId)) {
			if (results.has(entry.item.toolCallId)) return [];
			return [{ id: entry.entryId, type: "advisor" as const, text: "Consulting the selected model…", transient: entry.transient, label: "Advisor" }];
		}
		if (entry.type === "item" && entry.item.type === "toolResult" && calls.has(entry.item.toolCallId)) {
			const item = entry.item;
			let value: unknown;
			try { value = JSON.parse(item.text); } catch { /* Core policy/recovery errors are plain text tool results. */ }
			if (typeof value !== "object" || value === null) return [{ ...chatListItem(item), id: entry.entryId, type: "advisor" as const, label: "Advisor" }];
			const result = value as Record<string, unknown>;
			const model = result.model as { provider?: unknown; model?: unknown } | undefined;
			const modelLabel = typeof model?.provider === "string" && typeof model.model === "string" ? `${model.provider}/${model.model}` : "Advisor";
			const advice = typeof result.advice === "string" ? result.advice : typeof result.message === "string" ? result.message : result.status === "limitReached" ? "The advisor call limit for this Turn has been reached." : "No advice returned";
			const usage = result.usage as { inputTokens?: number; outputTokens?: number } | undefined;
			const details = [typeof result.question === "string" ? result.question : undefined, typeof result.sourceSequence === "number" ? `Conversation sequence ${result.sourceSequence}` : undefined, usage ? `Tokens: ${usage.inputTokens ?? "unknown"} input · ${usage.outputTokens ?? "unknown"} output` : undefined].filter(Boolean).join(" · ");
			return [{ id: entry.entryId, type: "advisor" as const, text: advice, transient: false, isError: item.isError, label: `Advisor · ${modelLabel}`, detail: details }];
		}
		return [chatTranscriptListItem(entry, { actionsEnabled: entry.turnId === latestTurnId })];
	});
}

/** Maps one backend-assembled transcript entry to Chat presentation. */
export function chatTranscriptListItem(entry: ThreadTranscriptEntry, options: TranscriptListItemOptions = {}): IChatListItem {
	switch (entry.type) {
		case "item": return { ...chatListItem(entry.item, entry.transient), id: entry.entryId };
		case "turnPlan": return { ...chatPlanUpdateListItem(entry.turnId, entry.plan), id: entry.entryId };
		case "turnError": {
			const presentation = turnErrorPresentation(entry.turnId, entry.error);
			return {
				id: entry.entryId,
				type: "turnError",
				text: entry.error.message,
				transient: false,
				isError: true,
				label: presentation.label,
				detail: presentation.detail,
				errorCode: entry.error.code,
				action: options.actionsEnabled === false ? undefined : presentation.action,
			};
		}
		case "toolOutput": return {
			id: entry.entryId,
			type: "toolResult",
			text: entry.text,
			transient: true,
			isError: entry.stream === "stderr",
			label: entry.stream === "stderr" ? "Tool stderr" : "Tool stdout",
		};
	}
}

interface TranscriptListItemOptions {
	readonly actionsEnabled?: boolean;
}

/** Projects one durable Turn failure as a conversation item. */
export function chatTurnErrorListItem(turn: Turn, options: ChatTurnErrorListItemOptions = {}): IChatListItem | undefined {
	if (turn.status !== "failed") return undefined;
	const error = turn.error ?? undefined;
	const presentation = error ? turnErrorPresentation(turn.turnId, error) : undefined;
	return {
		id: `turn-error:${turn.turnId}`,
		type: "turnError",
		text: error?.message ?? "Turn failed",
		transient: false,
		isError: true,
		label: presentation?.label,
		detail: presentation?.detail,
		errorCode: error?.code,
		action: options.actionsEnabled === false ? undefined : presentation?.action,
	};
}

function turnErrorPresentation(turnId: string, error: TurnError): { readonly label: string; readonly detail: string; readonly action: ChatTurnErrorAction } {
	switch (error.code) {
		case "connectionFailed":
		case "providerUnavailable":
		case "providerHttp":
		case "modelInvocationFailed":
			return retryPresentation(turnId, "Model error", "The model request may have failed temporarily.");
		case "contextOverflow":
			return {
				label: "Context limit",
				detail: "Automatic context recovery was exhausted. Start a new chat or send a smaller request.",
				action: { type: "startNewChat", label: "Start new chat" },
			};
		case "modelConfiguration":
		case "providerCredentials":
		case "providerAuth":
			return {
				label: "Authentication",
				detail: "Choose a model with working credentials before sending another message.",
				action: { type: "chooseModel", label: "Choose another model" },
			};
		case "invalidRequest":
			return revisePresentation("Invalid request", "Revise the request or choose a different model.");
		case "invalidResponse":
			return retryPresentation(turnId, "Invalid response", "The model returned a response Ash could not use.");
		case "completionPersistenceFailed":
			return retryPresentation(turnId, "Save failed", "The Turn completion could not be saved. Review the conversation before retrying.");
		case "interactionDeadlineElapsed":
			return retryPresentation(turnId, "Interaction expired", "The requested interaction expired before it received a response.");
		case "toolRepetition":
			return revisePresentation("Repeated tool failure", "The same tool and arguments failed five times. Ask Ash to use a different approach or explain the blocker.");
		case "rateLimited":
		case "usageLimited":
			return {
				label: "Usage limit",
				detail: "The model provider's usage limit was reached. Choose another model or try again later.",
				action: { type: "chooseModel", label: "Choose another model" },
			};
		case "worktreeCaptureFailed":
			return retryPresentation(turnId, "Worktree capture failed", "The Turn could not create its immutable worktree baseline, so write tools were not allowed.");
	}
}

function retryPresentation(turnId: string, label: string, detail: string): { readonly label: string; readonly detail: string; readonly action: ChatTurnErrorAction } {
	return { label, detail, action: { type: "retry", label: "Try again", turnId } };
}

function revisePresentation(label: string, detail: string): { readonly label: string; readonly detail: string; readonly action: ChatTurnErrorAction } {
	return { label, detail, action: { type: "revise", label: "Change approach" } };
}

/** Maps a Chat Thread item without interpreting untrusted content. */
export function chatListItem(item: ThreadItem, transient = false): IChatListItem {
	switch (item.type) {
		case "userMessage":
		case "agentMessage":
		case "reasoning":
		case "plan":
			return {
				id: item.itemId,
				type: item.type,
				text: item.text,
				transient,
			};
		case "userContext":
			return {
				id: item.itemId,
				type: item.type,
				text: item.name,
				transient,
			};
		case "userImage":
		case "userImageAttachment":
			return {
				id: item.itemId,
				type: item.type,
				text: "Image",
				transient,
			};
		case "userAudioAttachment":
			return {
				id: item.itemId,
				type: item.type,
				text: `Audio (${Math.ceil(item.attachment.durationMs / 1000)} seconds)`,
				transient,
			};
		case "toolCall":
			return {
				id: item.itemId,
				type: item.type,
				text: `${item.name}\n${item.argumentsJson}`,
				transient,
			};
		case "toolResult":
			return {
				id: item.itemId,
				type: item.type,
				text: item.text,
				transient,
				isError: item.isError,
			};
	}
}

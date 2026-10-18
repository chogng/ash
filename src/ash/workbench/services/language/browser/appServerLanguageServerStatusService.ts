import { Disposable, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { DeferredPromise } from "../../../../base/common/async.js";
import { onUnexpectedError } from "../../../../base/common/errors.js";
import { CommandsRegistry } from "../../../../platform/commands/common/commands.js";
import { status } from "../../../../base/browser/ui/aria/aria.js";
import { localize } from "../../../../nls.js";
import { DialogSeverity, IDialogService } from "../../../../platform/dialogs/common/dialogs.js";
import { type IServerEventApi } from "../../../../platform/agentHost/common/appServerApi.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { IProgressService, ProgressLocation, type IProgress, type IProgressStep } from "../../../../platform/progress/common/progress.js";
import { type LanguageServerMessageNotification, type LanguageServerMessageSeverityDto, type LanguageServerProgressNotification, type LanguageServerStateDto, type LanguageServerStateNotification } from "../../../../../../.build/protocol/typescript/index.js";
import { IOutputService, type IOutputChannel } from "../../output/common/output.js";
import { IStatusbarService, StatusbarAlignment, type IStatusbarEntry, type IStatusbarEntryAccessor } from "../../statusbar/browser/statusbar.js";

let nextOutputCommand = 0;

interface LanguageServerTask {
	readonly completion: DeferredPromise<void>;
	progress?: IProgress<IProgressStep>;
	title: string;
	percentage?: number;
}

interface LanguageServerLifecycleState {
	readonly server: string;
	readonly state: "starting" | "ready" | "backingOff" | "crashLoop" | "failed" | "stopped";
	readonly attempt?: number;
	readonly retryAfterMillis?: number;
	readonly restartAttempts?: number;
	readonly message?: string;
}

/** Projects App Server language notifications into Workbench dialogs, logs, and status. */
export class AppServerLanguageServerStatusService extends Disposable {
	private readonly channels = new Map<string, IOutputChannel>();
	// Tokens only correlate protocol notifications; task state belongs to IProgressService.
	private readonly progress = new Map<string, LanguageServerTask>();
	private readonly states = new Map<string, LanguageServerLifecycleState>();
	private readonly status = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		events: IServerEventApi,
		@IDialogService private readonly dialogs: IDialogService,
		@IOutputService private readonly outputService: IOutputService,
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@IProgressService private readonly progressService: IProgressService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		this._register(toDisposable(() => {
			for (const task of this.progress.values()) void task.completion.complete(undefined);
			this.progress.clear();
		}));
		const subscription = events.subscribe(event => {
			if (event.method === "language/serverMessage") this.acceptMessage(event.params);
			if (event.method === "language/serverProgress") this.acceptProgress(event.params);
			if (event.method === "language/serverState") this.acceptState(event.params);
		});
		this._register(toDisposable(() => subscription.dispose()));
	}

	private acceptMessage(message: LanguageServerMessageNotification): void {
		const text = message.message.trim();
		if (!text) return;
		const server = this.serverLabel(message.server, message.dirId);
		this.ensureChannel(server).appendLine({ severity: message.severity, category: message.source, text });
		if (message.show) void this.dialogs.showMessage({ title: server, severity: dialogSeverity(message.severity), message: text });
	}

	private acceptState(update: LanguageServerStateNotification): void {
		const server = this.serverLabel(update.server, update.dirId);
		const state = lifecycleState(server, update.state);
		this.states.set(server, state);
		const presentation = lifecyclePresentation(state);
		this.ensureChannel(server).appendLine({ severity: presentation.severity, category: "lifecycle", text: presentation.text });
		this.updateStatus();
	}

	private acceptProgress(update: LanguageServerProgressNotification): void {
		const server = this.serverLabel(update.server, update.dirId);
		this.ensureChannel(server);
		const key = `${update.dirId ?? ""}\0${update.server}\0${update.token}`;
		let task = this.progress.get(key);
		if (update.done) {
			if (task) void task.completion.complete(undefined);
			this.progress.delete(key);
		} else {
			const installing = update.token === "ash.language-server.install";
			const title = installing ? localize('languageServer.installing', "Installing {0}…", update.server) : update.title?.trim();
			if (!task) {
				task = { completion: new DeferredPromise<void>(), title: title || localize('languageServer.operation', "Language server operation") };
				this.progress.set(key, task);
				if (installing) {
					status(task.title);
					this.ensureChannel(server).appendLine({ severity: "information", category: "installation", text: task.title });
				}
				const commandId = `ash.languageServers.showOutput.${++nextOutputCommand}`;
				const channelId = outputChannelId(server);
				const command = CommandsRegistry.register(commandId, accessor => accessor.get(IOutputService).showChannel(channelId));
				const current = task;
				void this.progressService.withProgress({
					location: ProgressLocation.Window,
					title: installing ? task.title : server,
					command: commandId,
				}, progress => {
					current.progress = progress;
					const percentage = current.percentage === undefined ? "" : ` ${current.percentage}%`;
					progress.report({ message: installing ? percentage.trim() : `${current.title}${percentage}` });
					return current.completion.p;
				}).finally(() => command.dispose()).catch(onUnexpectedError);
			}
			if (title) task.title = title;
			if (update.percentage != null) task.percentage = update.percentage;
			const percentage = task.percentage === undefined ? "" : ` ${task.percentage}%`;
			task.progress?.report({ message: installing ? percentage.trim() : `${task.title}${percentage}` });
		}
		this.updateStatus();
	}

	private updateStatus(): void {
		const reveal = (server: string): void => this.ensureChannel(server).show();
		const entry = this.progress.size > 0 ? undefined : lifecycleStatusEntry([...this.states.values()], reveal);
		if (!entry) { this.status.clear(); return; }
		if (this.status.value) this.status.value.update(entry);
		else this.status.value = this.statusbar.addEntry(entry, { id: "ash.status.languageServers", alignment: StatusbarAlignment.Right, priority: 20 });
	}

	private ensureChannel(server: string): IOutputChannel {
		const id = outputChannelId(server);
		const existing = this.channels.get(id);
		if (existing) return existing;
		const label = server.trim() || "Language Server";
		const channel = this._register(this.outputService.createChannel({ id, label, kind: "log", source: "core" }));
		this.channels.set(id, channel);
		return channel;
	}

	private serverLabel(server: string, dirId: string | undefined): string {
		if (!dirId) return server;
		const folder = this.workspace.getWorkspace().folders.find(folder => folder.id === dirId);
		return `${server} — ${folder?.name || dirId}`;
	}
}

function lifecycleState(server: string, dto: LanguageServerStateDto): LanguageServerLifecycleState {
	switch (dto.type) {
		case "starting": return Object.freeze({ server, state: "starting" });
		case "ready": return Object.freeze({ server, state: "ready" });
		case "backingOff": return Object.freeze({ server, state: "backingOff", attempt: dto.attempt, retryAfterMillis: dto.retryAfterMillis });
		case "crashLoop": return Object.freeze({ server, state: "crashLoop", restartAttempts: dto.restartAttempts, message: dto.message });
		case "failed": return Object.freeze({ server, state: "failed", message: dto.message });
		case "stopped": return Object.freeze({ server, state: "stopped" });
	}
}

function lifecyclePresentation(state: LanguageServerLifecycleState): { readonly severity: "information" | "warning" | "error" | "log"; readonly text: string; } {
	switch (state.state) {
		case "starting": return { severity: "information", text: "Starting language server…" };
		case "ready": return { severity: "information", text: "Language server is ready." };
		case "backingOff": return { severity: "warning", text: `Language server stopped unexpectedly; restart attempt ${state.attempt ?? 0} begins in ${formatDelay(state.retryAfterMillis ?? 0)}.` };
		case "crashLoop": return { severity: "error", text: `Language server entered a crash loop after ${state.restartAttempts ?? 0} restart attempts: ${state.message ?? "Unknown failure"}` };
		case "failed": return { severity: "error", text: `Language server failed: ${state.message ?? "Unknown failure"}` };
		case "stopped": return { severity: "log", text: "Language server stopped." };
	}
}

function lifecycleStatusEntry(states: readonly LanguageServerLifecycleState[], reveal: (server: string) => void): IStatusbarEntry | undefined {
	const state = [...states].sort((left, right) => lifecyclePriority(right) - lifecyclePriority(left))[0];
	if (!state || lifecyclePriority(state) === 0) return undefined;
	const presentation = lifecyclePresentation(state);
	const text = state.state === "starting" ? `${state.server}: Starting` : state.state === "backingOff" ? `${state.server}: Restarting` : `${state.server}: Failed`;
	return { text, tooltip: presentation.text, run: () => reveal(state.server) };
}

function lifecyclePriority(state: LanguageServerLifecycleState): number {
	if (state.state === "crashLoop" || state.state === "failed") return 3;
	if (state.state === "backingOff") return 2;
	if (state.state === "starting") return 1;
	return 0;
}

function formatDelay(millis: number): string {
	if (millis < 1_000) return `${millis}ms`;
	const seconds = millis / 1_000;
	return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

function outputChannelId(server: string): string {
	return `language-server.${encodeURIComponent(server.trim() || "unknown")}`;
}

function dialogSeverity(severity: LanguageServerMessageSeverityDto): DialogSeverity {
	if (severity === "error") return DialogSeverity.Error;
	if (severity === "warning") return DialogSeverity.Warning;
	return DialogSeverity.Info;
}

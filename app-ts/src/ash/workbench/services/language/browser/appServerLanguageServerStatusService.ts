import { Emitter } from "../../../../base/common/event.js";
import { Disposable, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { DialogSeverity, type IDialogService } from "../../../../platform/dialogs/common/dialogs.js";
import { type IServerEventApi } from "../../../../platform/app-server/common/appServerApi.js";
import { type IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { type LanguageServerMessageNotification, type LanguageServerMessageSeverityDto, type LanguageServerProgressNotification, type LanguageServerStateDto, type LanguageServerStateNotification } from "../../../../platform/app-server/common/generated/index.js";
import type { IOutputChannel, IOutputService } from "../../output/common/outputService.js";
import { StatusbarAlignment, type IStatusbarEntry, type IStatusbarEntryAccessor, type IStatusbarService } from "../../statusbar/browser/statusbar.js";
import { type ILanguageServerStatusService, type LanguageServerLifecycleState, type LanguageServerProgressState } from "../common/languageServerStatusService.js";

/** Projects App Server language notifications into Workbench dialogs, logs, and status. */
export class AppServerLanguageServerStatusService extends Disposable implements ILanguageServerStatusService {
	private readonly changeEmitter = this._register(new Emitter<void>());
	private readonly channels = new Map<string, IOutputChannel>();
	private readonly progress = new Map<string, LanguageServerProgressState>();
	private readonly states = new Map<string, LanguageServerLifecycleState>();
	private readonly status = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	readonly onDidChange = this.changeEmitter.event;

	constructor(events: IServerEventApi, private readonly dialogs: IDialogService, private readonly outputService: IOutputService, private readonly statusbar: IStatusbarService, private readonly workspace?: IWorkspaceContextService) {
		super();
		const subscription = events.subscribe(event => {
			if (event.method === "language/serverMessage") this.acceptMessage(event.params);
			if (event.method === "language/serverProgress") this.acceptProgress(event.params);
			if (event.method === "language/serverState") this.acceptState(event.params);
		});
		this._register(toDisposable(() => subscription.dispose()));
	}

	getProgress(): readonly LanguageServerProgressState[] {
		return Object.freeze([...this.progress.values()]);
	}

	getStates(): readonly LanguageServerLifecycleState[] {
		return Object.freeze([...this.states.values()]);
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
		this.changeEmitter.fire();
	}

	private acceptProgress(update: LanguageServerProgressNotification): void {
		const server = this.serverLabel(update.server, update.dirId);
		this.ensureChannel(server);
		const key = `${server}\0${update.token}`;
		const current = this.progress.get(key);
		if (update.done) {
			this.progress.delete(key);
		} else {
			const title = update.title?.trim() || current?.title || "Language server operation";
			this.progress.set(key, Object.freeze({ server, token: update.token, title, ...(update.message?.trim() ? { message: update.message.trim() } : current?.message ? { message: current.message } : {}), ...(update.percentage === null ? current?.percentage === undefined ? {} : { percentage: current.percentage } : { percentage: update.percentage }) }));
		}
		this.updateStatus();
		this.changeEmitter.fire();
	}

	private updateStatus(): void {
		const active = [...this.progress.values()];
		const reveal = (server: string): void => this.ensureChannel(server).show();
		const entry = active.length > 0 ? progressStatusEntry(active, reveal) : lifecycleStatusEntry([...this.states.values()], reveal);
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
		const folder = this.workspace?.getWorkspace().folders.find(folder => folder.id === dirId);
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

function lifecyclePresentation(state: LanguageServerLifecycleState): { readonly severity: "information" | "warning" | "error" | "log"; readonly text: string } {
	switch (state.state) {
		case "starting": return { severity: "information", text: "Starting language server…" };
		case "ready": return { severity: "information", text: "Language server is ready." };
		case "backingOff": return { severity: "warning", text: `Language server stopped unexpectedly; restart attempt ${state.attempt ?? 0} begins in ${formatDelay(state.retryAfterMillis ?? 0)}.` };
		case "crashLoop": return { severity: "error", text: `Language server entered a crash loop after ${state.restartAttempts ?? 0} restart attempts: ${state.message ?? "Unknown failure"}` };
		case "failed": return { severity: "error", text: `Language server failed: ${state.message ?? "Unknown failure"}` };
		case "stopped": return { severity: "log", text: "Language server stopped." };
	}
}

function progressStatusEntry(active: readonly LanguageServerProgressState[], reveal: (server: string) => void): IStatusbarEntry {
	const first = active[0]!;
	const percentage = first.percentage === undefined ? "" : ` ${first.percentage}%`;
	const suffix = active.length === 1 ? "" : ` (+${active.length - 1})`;
	return { text: `${first.title}${percentage}${suffix}`, tooltip: [first.server, first.message].filter(Boolean).join(": "), run: () => reveal(first.server) };
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

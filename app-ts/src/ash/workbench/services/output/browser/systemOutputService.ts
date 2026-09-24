import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { IAppServerApi } from "../../../../platform/app-server/common/appServerApi.js";
import type { ILogSink, LogEntry } from "../../../../platform/log/common/log.js";
import type { IOutputChannel, IOutputService } from "../common/outputService.js";

/** Owns built-in Window and App Server diagnostic Output channels. */
export class SystemOutputService extends Disposable implements ILogSink {
	private readonly windowChannel: IOutputChannel;
	private readonly appServerChannel: IOutputChannel;

	constructor(output: IOutputService, appServer: IAppServerApi) {
		super();
		this.windowChannel = this._register(output.createChannel({ id: "window", label: "Window", kind: "log", source: "core" }));
		this.appServerChannel = this._register(output.createChannel({ id: "app-server", label: "App Server", kind: "log", source: "core" }));
		const connection = appServer.onConnectionState(state => this.appServerChannel.appendLine({ severity: state === "crashed" ? "error" : state === "restarting" ? "warning" : "information", category: "connection", text: `App Server connection is ${state}.` }));
		this._register(toDisposable(() => connection.dispose()));
		void appServer.getConnectionState().then(state => {
			if (!this.isDisposed) this.appServerChannel.appendLine({ severity: state === "crashed" ? "error" : "information", category: "connection", text: `Initial App Server connection state: ${state}.` });
		}).catch(error => {
			if (!this.isDisposed) this.appServerChannel.appendLine({ severity: "error", category: "connection", text: `Could not read App Server connection state: ${errorMessage(error)}` });
		});
	}

	log(entry: LogEntry): void {
		this.windowChannel.appendLine({ severity: entry.level, category: entry.category, text: `${entry.message}${entry.error === undefined ? "" : `: ${errorMessage(entry.error)}`}` });
	}

}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.stack || error.message;
	return String(error);
}

function bounded(value: string): string {
	return value.slice(0, 16 * 1024);
}

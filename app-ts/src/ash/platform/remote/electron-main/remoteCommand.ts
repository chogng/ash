import { spawn } from "node:child_process";
import { throwIfCancelled } from "../../../base/common/cancellation.js";
import { CancellationError } from "../../../base/common/errors.js";

const SSH_HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/;
const MAX_OUTPUT_LENGTH = 1024 * 1024;

export interface RemoteCommandResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export interface RemoteCommandObserver {
	readonly onStderrData: (chunk: string) => void;
	readonly signal?: AbortSignal;
}

export type RunRemoteCommand = (executable: string, args: readonly string[], environment: NodeJS.ProcessEnv, observer?: RemoteCommandObserver) => Promise<RemoteCommandResult>;

export function normalizeCredentialFreeSshHost(host: string): string {
	const normalized = host.trim().toLowerCase();
	if (!SSH_HOST_PATTERN.test(normalized)) throw new Error("Remote command requires a credential-free OpenSSH config host");
	return normalized;
}

export function validLocalCommand(value: string): boolean {
	return value.trim().length > 0 && !value.includes("\0") && !value.includes("\n") && !value.includes("\r");
}

export function isCanonicalAbsolutePosixPath(value: string): boolean {
	if (!value.startsWith("/") || value === "/" || value.endsWith("/") || value.includes("\0") || value.includes("\n") || value.includes("\r")) return false;
	return value.split("/").slice(1).every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

export function runRemoteCommand(executable: string, args: readonly string[], environment: NodeJS.ProcessEnv, observer?: RemoteCommandObserver): Promise<RemoteCommandResult> {
	if (observer?.signal) throwIfCancelled(observer.signal, "Remote command cancelled");
	const child = spawn(executable, [...args], { env: { ...environment }, shell: false, stdio: "pipe" });
	child.stdin.end();
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let observerFailed = false;
		let observerFailure: unknown;
		let cancelled = false;
		const signal = observer?.signal;
		const removeAbortListener = (): void => signal?.removeEventListener("abort", abort);
		const abort = (): void => {
			cancelled = true;
			child.kill();
		};
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", chunk => { stdout = appendBounded(stdout, String(chunk)); });
		child.stderr.on("data", chunk => {
			const text = String(chunk);
			if (!observerFailed) {
				try {
					observer?.onStderrData(text);
				} catch (error) {
					observerFailed = true;
					observerFailure = error;
					child.kill();
				}
			}
			stderr = appendBounded(stderr, text);
		});
		child.once("error", error => {
			removeAbortListener();
			reject(cancelled ? new CancellationError("Remote command cancelled", signal?.reason) : error);
		});
		child.once("close", exitCode => {
			removeAbortListener();
			if (cancelled) reject(new CancellationError("Remote command cancelled", signal?.reason));
			else if (observerFailed) reject(observerFailure);
			else resolve({ exitCode, stdout, stderr });
		});
	});
}

function appendBounded(value: string, addition: string): string {
	const next = value + addition;
	return next.length <= MAX_OUTPUT_LENGTH ? next : next.slice(0, MAX_OUTPUT_LENGTH);
}

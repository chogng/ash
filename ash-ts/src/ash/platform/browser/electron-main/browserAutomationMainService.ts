import { type BrowserCloseParams, type BrowserCreateParams, type BrowserCreateResult, type BrowserObserveParams, type BrowserObserveResult, type BrowserPerformParams, type BrowserPerformResult } from "../../app-server/common/generated/index.js";
import { type IDisposable, toDisposable } from "../../../base/common/lifecycle.js";
import type { IBrowserViewMainService } from "./browserViewIpc.js";
import { BrowserTargetRegistry, type BrowserDebuggerClient, type BrowserTargetHandle } from "./browserTargetRegistry.js";

const MAX_OBSERVATION_BYTES = 8 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;

interface BrowserAutomationRuntime {
	readonly browserViews: IBrowserViewMainService;
	readonly targets: BrowserTargetRegistry;
}

interface BrowserHostRequestContext { readonly signal: AbortSignal; }

/** Electron Main implementation of App Server's semantic browser host contract. */
export class BrowserAutomationMainService {
	private runtime: BrowserAutomationRuntime | undefined;
	private readonly debuggerTurns = new Map<string, Promise<void>>();
	private readonly hostedTargets = new Set<string>();

	bind(browserViews: IBrowserViewMainService, targets: BrowserTargetRegistry): IDisposable {
		if (this.runtime) throw new Error("BrowserAutomationRuntimeAlreadyBound");
		const runtime = { browserViews, targets };
		this.runtime = runtime;
		return toDisposable(() => {
			if (this.runtime !== runtime) return;
			this.reset();
			this.runtime = undefined;
		});
	}

	async create(params: BrowserCreateParams, context: BrowserHostRequestContext): Promise<BrowserCreateResult> {
		const runtime = this.requireRuntime();
		throwIfAborted(context.signal);
		const state = await runtime.browserViews.createTarget({ url: params.url });
		if (this.runtime !== runtime || context.signal.aborted) {
			try {
				runtime.browserViews.close(state.targetId);
			} catch {
				// Runtime retirement may already have closed the newly created target.
			}
			throwIfAborted(context.signal);
			throw new Error("BrowserCapabilityUnavailable");
		}
		this.hostedTargets.add(state.targetId);
		return { targetId: state.targetId };
	}

	async observe(params: BrowserObserveParams, context: BrowserHostRequestContext): Promise<BrowserObserveResult> {
		const runtime = this.requireRuntime();
		const target = runtime.targets.target(params.targetId);
		const state = runtime.browserViews.observe(params.targetId);
		const snapshots = params.includeAccessibilityTree || params.includeDomSnapshot
			? await this.withDebugger(target, context.signal, async (debuggerClient) => {
					const accessibilityTree = params.includeAccessibilityTree
						? boundedJson(await debuggerClient.sendCommand("Accessibility.getFullAXTree"), "accessibility tree")
						: undefined;
					const domSnapshot = params.includeDomSnapshot
						? boundedJson(await debuggerClient.sendCommand("DOMSnapshot.captureSnapshot", { computedStyles: [] }), "DOM snapshot")
						: undefined;
					return {
						...(accessibilityTree === undefined ? {} : { accessibilityTree }),
						...(domSnapshot === undefined ? {} : { domSnapshot }),
					};
				})
			: {};
		throwIfAborted(context.signal);
		const screenshot = params.includeScreenshot ? await captureScreenshot(target, context.signal) : undefined;
		return {
			targetId: state.targetId,
			url: state.url,
			title: state.title,
			loading: state.loading,
			...snapshots,
			...(screenshot === undefined ? {} : { screenshot }),
		};
	}

	async perform(params: BrowserPerformParams, context: BrowserHostRequestContext): Promise<BrowserPerformResult> {
		const runtime = this.requireRuntime();
		const action = params.action;
		const targetId = action.targetId;
		runtime.targets.target(targetId);
		throwIfAborted(context.signal);
		switch (action.type) {
			case "navigate":
				await runtime.browserViews.navigate({ targetId, url: action.url });
				break;
			case "click":
				await this.withDebugger(runtime.targets.target(targetId), context.signal, debuggerClient => clickNode(debuggerClient, action.target.nodeId, context.signal));
				break;
			case "typeText":
				await this.withDebugger(runtime.targets.target(targetId), context.signal, async (debuggerClient) => {
					if (action.target.type === "element") await focusNode(debuggerClient, action.target.target.nodeId, context.signal);
					throwIfAborted(context.signal);
					await debuggerClient.sendCommand("Input.insertText", { text: action.text });
				});
				break;
			case "scroll":
				await this.withDebugger(runtime.targets.target(targetId), context.signal, async (debuggerClient) => {
					const bounds = runtime.targets.target(targetId).view.getBounds();
					await debuggerClient.sendCommand("Input.dispatchMouseEvent", {
						type: "mouseWheel",
						x: Math.max(0, Math.floor(bounds.width / 2)),
						y: Math.max(0, Math.floor(bounds.height / 2)),
						deltaX: action.deltaX,
						deltaY: action.deltaY,
					});
				});
				break;
			case "goBack":
				runtime.browserViews.goBack(targetId);
				break;
			case "reload":
				runtime.browserViews.reload(targetId);
				break;
		}
		throwIfAborted(context.signal);
		return { targetId };
	}

	close(params: BrowserCloseParams): null {
		try {
			this.requireRuntime().browserViews.close(params.targetId);
			return null;
		} finally {
			this.hostedTargets.delete(params.targetId);
		}
	}

	/** Closes targets owned by the retiring App Server host connection. */
	reset(): void {
		const runtime = this.runtime;
		const targetIds = [...this.hostedTargets];
		this.hostedTargets.clear();
		if (!runtime) return;
		for (const targetId of targetIds) {
			try {
				runtime.browserViews.close(targetId);
			} catch {
				// A renderer or page crash may already have released the exact target.
			}
		}
	}

	private requireRuntime(): BrowserAutomationRuntime {
		if (!this.runtime) throw new Error("BrowserCapabilityUnavailable");
		return this.runtime;
	}

	private async withDebugger<R>(target: BrowserTargetHandle, signal: AbortSignal, operation: (debuggerClient: BrowserDebuggerClient) => Promise<R>): Promise<R> {
		const previous = this.debuggerTurns.get(target.targetId) ?? Promise.resolve();
		let releaseTurn: () => void = () => {};
		const turn = new Promise<void>(resolve => {
			releaseTurn = resolve;
		});
		const queued = previous.then(() => turn);
		this.debuggerTurns.set(target.targetId, queued);
		let debuggerClient: BrowserDebuggerClient | undefined;
		let attachedHere = false;
		try {
			await previous;
			throwIfAborted(signal);
			if (target.webContents.isDestroyed()) throw new Error("BrowserTargetUnavailable");
			debuggerClient = target.webContents.debugger;
			attachedHere = !debuggerClient.isAttached();
			if (attachedHere) debuggerClient.attach("1.3");
			return await operation(debuggerClient);
		} finally {
			try {
				if (attachedHere && debuggerClient?.isAttached()) debuggerClient.detach();
			} catch {
				// Target teardown owns a debugger session destroyed during the operation.
			}
			releaseTurn();
			void queued.finally(() => {
				if (this.debuggerTurns.get(target.targetId) === queued) this.debuggerTurns.delete(target.targetId);
			});
		}
	}
}

async function captureScreenshot(target: BrowserTargetHandle, signal: AbortSignal): Promise<NonNullable<BrowserObserveResult["screenshot"]>> {
	throwIfAborted(signal);
	const image = await target.view.webContents.capturePage();
	const png = image.toPNG();
	throwIfAborted(signal);
	if (png.byteLength > MAX_SCREENSHOT_BYTES) throw new Error("BrowserScreenshotTooLarge");
	return { mimeType: "image/png", dataBase64: png.toString("base64"), decodedLength: png.byteLength };
}

async function clickNode(debuggerClient: BrowserDebuggerClient, nodeId: string, signal: AbortSignal): Promise<void> {
	const objectId = await resolveNode(debuggerClient, nodeId);
	try {
		const location = await debuggerClient.sendCommand("Runtime.callFunctionOn", {
			objectId,
			functionDeclaration: "function () { this.scrollIntoView({ block: 'center', inline: 'center' }); const rect = this.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }",
			returnByValue: true,
		}) as { result?: { value?: { x?: unknown; y?: unknown } } };
		const x = finiteCoordinate(location.result?.value?.x, "x");
		const y = finiteCoordinate(location.result?.value?.y, "y");
		throwIfAborted(signal);
		await debuggerClient.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
		await debuggerClient.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
	} finally {
		await debuggerClient.sendCommand("Runtime.releaseObject", { objectId }).catch(() => {});
	}
}

async function focusNode(debuggerClient: BrowserDebuggerClient, nodeId: string, signal: AbortSignal): Promise<void> {
	const objectId = await resolveNode(debuggerClient, nodeId);
	try {
		throwIfAborted(signal);
		await debuggerClient.sendCommand("Runtime.callFunctionOn", { objectId, functionDeclaration: "function () { this.focus(); }" });
	} finally {
		await debuggerClient.sendCommand("Runtime.releaseObject", { objectId }).catch(() => {});
	}
}

async function resolveNode(debuggerClient: BrowserDebuggerClient, nodeId: string): Promise<string> {
	if (!/^[1-9][0-9]*$/.test(nodeId)) throw new Error("BrowserNodeIdInvalid");
	const backendNodeId = Number(nodeId);
	if (!Number.isSafeInteger(backendNodeId)) throw new Error("BrowserNodeIdInvalid");
	const resolved = await debuggerClient.sendCommand("DOM.resolveNode", { backendNodeId }) as { object?: { objectId?: unknown } };
	if (typeof resolved.object?.objectId !== "string") throw new Error("BrowserNodeUnavailable");
	return resolved.object.objectId;
}

function boundedJson(value: unknown, label: string): string {
	const serialized = JSON.stringify(value);
	if (Buffer.byteLength(serialized, "utf8") > MAX_OBSERVATION_BYTES) throw new Error(`Browser ${label} is too large`);
	return serialized;
}

function finiteCoordinate(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Browser click ${field} coordinate is invalid`);
	return value;
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("BrowserRequestCancelled");
}

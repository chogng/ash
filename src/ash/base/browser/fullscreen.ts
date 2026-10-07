import type { IDisposable } from "../common/lifecycle.js";
import { addDisposableListener } from "./dom.js";

export type FullscreenMode = "native" | "browser";

export interface FullscreenState {
	readonly mode: FullscreenMode;
	readonly element?: Element;
}

export function getFullscreenState(
	targetWindow: Window,
): FullscreenState | undefined {
	const element = targetWindow.document.fullscreenElement;
	if (element) return { mode: "native", element };

	const screen = targetWindow.screen;
	const browserFullscreen =
		Math.abs(targetWindow.innerWidth - screen.width) <= 1 &&
		Math.abs(targetWindow.innerHeight - screen.height) <= 1;
	return browserFullscreen ? { mode: "browser" } : undefined;
}

export async function requestFullscreen(element: Element): Promise<void> {
	if (element.ownerDocument.fullscreenElement === element) return;
	await element.requestFullscreen();
}

export async function exitFullscreen(
	targetDocument: Document,
): Promise<void> {
	if (!targetDocument.fullscreenElement) return;
	await targetDocument.exitFullscreen();
}

export function onDidChangeFullscreen(
	targetDocument: Document,
	listener: () => void,
): IDisposable {
	return addDisposableListener(
		targetDocument,
		"fullscreenchange",
		listener,
	);
}

import type { URI } from '../../base/common/uri.js';

export interface ICanvas {
	readonly resource: URI;
	readonly instanceId: string | undefined;
	readonly title: string;
	readonly status?: string;
	readonly source: URI | undefined;
	readonly extensionId?: string;
	readonly canvasId?: string;
}

export interface ICanvasOwner {
	readonly providerId: string;
	readonly session: URI;
	readonly chat: URI;
}

export interface ICanvasReference extends ICanvasOwner {
	readonly canvas: URI;
}

export function canvasOwnerKey(owner: ICanvasOwner): string {
	return JSON.stringify([owner.providerId, owner.session.toString(), owner.chat.toString()]);
}

export function isCanvasOwner(first: ICanvasOwner, second: ICanvasOwner): boolean {
	return canvasOwnerKey(first) === canvasOwnerKey(second);
}

export function getCanvasReferenceKey(reference: ICanvasReference): string {
	return JSON.stringify([canvasOwnerKey(reference), reference.canvas.toString()]);
}

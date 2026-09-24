export {};

// These errors must remain errors in the same compilation as every common layer.
// @ts-expect-error Window APIs are not part of the common runtime.
window;
// @ts-expect-error DOM APIs are not part of the common runtime.
document;
// @ts-expect-error DOM element types must not leak into common code.
let element: HTMLElement;
// @ts-expect-error DOM scope traversal belongs to browser implementations.
let node: Node;
// @ts-expect-error Window contracts belong to browser implementations.
let ownerWindow: Window;
// @ts-expect-error Worker startup belongs to the browser runtime.
new Worker('worker.js');
// @ts-expect-error Renderer file helpers must not introduce File into common.
let file: File;
// @ts-expect-error Node globals must not leak into common code.
process;
// @ts-expect-error Node modules must not leak into common code.
import 'node:fs';

const handle = setTimeout(() => {}, 0);
clearTimeout(handle);
// @ts-expect-error Shared timer handles cannot assume browser number handles.
const browserHandle: number = handle;
// @ts-expect-error Shared timer handles cannot assume Node methods.
handle.unref();

const uuid: string = crypto.randomUUID();
const bytes: Uint8Array<ArrayBuffer> = new TextEncoder().encode(uuid);
new TextDecoder().decode(bytes);

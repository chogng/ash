export {};

// These errors must remain errors in the same compilation as base/common.
// @ts-expect-error Window APIs are not part of the common runtime.
window;
// @ts-expect-error DOM APIs are not part of the common runtime.
document;
// @ts-expect-error DOM element types must not leak into common code.
let element: HTMLElement;
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

// Runtime generated from model.ts by the browser build's preparePrototypeCodec.
import type { Reader } from 'protobufjs/minimal.js';
export const ashCodecPrototype: Record<string, {
	encode(value: Record<string, unknown>): { finish(): Uint8Array<ArrayBuffer>; };
	decode(value: Reader): Record<string, unknown>;
}>;

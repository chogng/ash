import { Reader } from 'protobufjs/minimal.js';
import { ashCodecPrototype } from './codec.js';
import { models } from './model.js';

type RecordValue = Record<string, unknown>;
const own = (value: object, key: string): boolean => Object.hasOwn(value, key);
const unpairedSurrogate = /[\uD800-\uDFFF]/u;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
class StrictReader extends Reader {
	public override string(): string { return utf8.decode(this.bytes()); }
}
function record(value: unknown): RecordValue {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a prototype record');
	return value as RecordValue;
}
function set(target: RecordValue, key: string, value: unknown): void {
	// Preserve JSON own keys, including __proto__, without invoking a setter.
	Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}
function utf16Bytes(value: string): Uint8Array {
	const bytes = new Uint8Array(value.length * 2);
	const view = new DataView(bytes.buffer);
	for (let index = 0; index < value.length; index++) view.setUint16(index * 2, value.charCodeAt(index), true);
	return bytes;
}
function utf16Text(bytes: Uint8Array): string {
	if (bytes.byteLength % 2) throw new TypeError('Invalid UTF-16 extension');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let text = '';
	for (let index = 0; index < bytes.length; index += 2) text += String.fromCharCode(view.getUint16(index, true));
	return text;
}
function generic(value: unknown): RecordValue {
	if (value === null) return { nullValue: true };
	if (typeof value === 'string') {
		if (!unpairedSurrogate.test(value)) return { text: value };
		return { utf16: utf16Bytes(value) };
	}
	if (typeof value === 'boolean') return { boolean: value };
	if (typeof value === 'number' && Number.isFinite(value)) return { number: value };
	if (Array.isArray(value)) return { array: { values: value.map(generic) } };
	return { object: object(record(value)) };
}
function object(value: RecordValue): RecordValue {
	return { fields: Object.entries(value).map(([name, value]) => ({ ...(unpairedSurrogate.test(name) ? { utf16Name: utf16Bytes(name) } : { name }), value: generic(value) })) };
}
function pack(type: string, value: unknown): unknown {
	if (type === 'JsonValue') return generic(value);
	if (type === 'string' || type === 'bool' || type === 'double' || type === 'uint32' || type === 'uint64') {
		if (type === 'string' ? typeof value !== 'string' : type === 'bool' ? typeof value !== 'boolean'
			: typeof value !== 'number' || !Number.isFinite(value) || (type === 'uint32' && (!Number.isInteger(value) || value < 0 || value > 0xffffffff))
			|| (type === 'uint64' && (!Number.isSafeInteger(value) || value < 0))
			|| ((type === 'uint32' || type === 'uint64') && Object.is(value, -0))) throw new TypeError('Value cannot use this scalar encoding');
		if (type === 'string' && unpairedSurrogate.test(value as string)) throw new TypeError('Use the lossless UTF-16 extension');
		return value;
	}
	const model = models[type]!;
	if (model.array) {
		if (!Array.isArray(value)) throw new TypeError('Expected a prototype array');
		return { values: value.map(item => pack(model.array!, item)) };
	}
	const result: RecordValue = {};
	const extras: RecordValue = {};
	for (const [name, child] of Object.entries(record(value))) {
		const field = own(model.fields!, name) ? model.fields![name] : undefined;
		if (field) {
			try { set(result, name, pack(field, child)); continue; } catch (error) { if (!(error instanceof TypeError)) throw error; }
		}
		// Unknown fields and values that cannot use a typed wire field remain
		// lossless JSON values. The existing schema decides whether they are legal.
		set(extras, name, child);
	}
	if (Object.keys(extras).length) result.extras = object(extras);
	return result;
}
function checked(value: unknown): RecordValue {
	const result = record(value);
	if (own(result, '$unknowns')) throw new TypeError('Unknown prototype wire field');
	return result;
}
function unpackObject(value: unknown): RecordValue {
	const result = checked(value);
	const fields = result.fields;
	if (!Array.isArray(fields)) throw new TypeError('Invalid prototype object');
	delete result.fields;
	Object.setPrototypeOf(result, Object.prototype);
	for (const entry of fields) {
		const field = checked(entry);
		if (own(field, 'name') === own(field, 'utf16Name') || !own(field, 'value')) throw new TypeError('Invalid prototype field');
		const name = own(field, 'utf16Name') ? utf16Text(field.utf16Name as Uint8Array) : field.name;
		if (typeof name !== 'string' || own(result, name)) throw new TypeError('Invalid or duplicate prototype field');
		set(result, name, unpackGeneric(field.value));
	}
	return result;
}
function unpackGeneric(value: unknown): unknown {
	const item = checked(value);
	const keys = ['number', 'text', 'boolean', 'nullValue', 'array', 'object', 'utf16'].filter(key => own(item, key));
	if (keys.length !== 1) throw new TypeError('Invalid prototype JSON union');
	switch (keys[0]) {
		case 'number': if (!Number.isFinite(item.number)) throw new TypeError('Invalid JSON number'); return item.number;
		case 'text': return item.text;
		case 'boolean': return item.boolean;
		case 'nullValue': if (item.nullValue !== true) throw new TypeError('Invalid null marker'); return null;
		case 'array': { const values = checked(item.array).values; if (!Array.isArray(values)) throw new TypeError('Invalid JSON array'); for (let index = 0; index < values.length; index++) values[index] = unpackGeneric(values[index]); return values; }
		case 'object': return unpackObject(item.object);
		case 'utf16': return utf16Text(item.utf16 as Uint8Array);
	}
}
function unpack(type: string, value: unknown): unknown {
	if (type === 'JsonValue') return unpackGeneric(value);
	// Static readers may still return Long with --force-number. Convert here;
	// the unchanged schema then rejects values outside JavaScript's safe range.
	if (type === 'uint64') return typeof value === 'number' ? value : (value as { toNumber(): number; }).toNumber();
	if (['string', 'bool', 'double', 'uint32', 'uint64'].includes(type)) return value;
	const item = checked(value);
	const model = models[type]!;
	if (model.array) {
		if (!Array.isArray(item.values)) throw new TypeError('Invalid prototype array');
		if (model.array !== 'uint32') for (let index = 0; index < item.values.length; index++) item.values[index] = unpack(model.array, item.values[index]);
		return item.values;
	}
	// Consume the fresh wire tree in place, including array wrappers. Do not
	// allocate another complete result graph before structured cloning it to UI.
	const extras = own(item, 'extras') ? unpackObject(item.extras) : {};
	delete item.extras;
	for (const [name, field] of Object.entries(model.fields!)) if (own(item, name)) {
		if (own(extras, name)) throw new TypeError('Conflicting prototype field');
		item[name] = unpack(field, item[name]);
	}
	Object.setPrototypeOf(item, Object.prototype);
	for (const [name, child] of Object.entries(extras)) set(item, name, child);
	return item;
}

/** Specialize the two measured result shapes; every other message stays lossless.
 * Routing still comes from the protocol client's pending snapshot, never the codec.
 */
export function encodePrototype(message: unknown, method?: string): Uint8Array<ArrayBuffer> {
	const envelope = { ...record(message) };
	if (own(envelope, 'threadRead') || own(envelope, 'syntaxQuery')) throw new TypeError('Reserved prototype envelope field');
	if (own(envelope, 'result') && (method === 'session/thread/read' || method === 'syntax/query')) {
		set(envelope, method === 'session/thread/read' ? 'threadRead' : 'syntaxQuery', envelope.result);
		delete envelope.result;
	}
	return ashCodecPrototype.Envelope.encode(pack('Envelope', envelope) as RecordValue).finish();
}
export function parsePrototype(bytes: Uint8Array): unknown {
	const reader = new StrictReader(bytes);
	reader.discardUnknown = false;
	return ashCodecPrototype.Envelope.decode(reader);
}
export function normalizePrototype(parsed: unknown): unknown {
	const envelope = unpack('Envelope', parsed) as RecordValue;
	for (const field of ['threadRead', 'syntaxQuery']) if (own(envelope, field)) {
		if (own(envelope, 'result')) throw new TypeError('Conflicting prototype result');
		envelope.result = envelope[field];
		delete envelope[field];
	}
	return envelope;
}

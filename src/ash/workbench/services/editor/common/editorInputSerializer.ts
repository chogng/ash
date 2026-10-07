import type { IResourceEditorInput } from '../../../common/editor.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';

export interface SerializedEditorInput {
	readonly typeId: string;
	readonly value: unknown;
}

export interface EditorInputSerializer {
	readonly typeId: string;
	canSerialize(input: IResourceEditorInput): boolean;
	serialize(input: IResourceEditorInput, registry: EditorInputSerializerRegistry): unknown;
	deserialize(value: unknown, registry: EditorInputSerializerRegistry): IResourceEditorInput;
}

/** Owns the wire-safe forms used by editor working sets. */
export class EditorInputSerializerRegistry {
	private readonly serializers = new Map<string, EditorInputSerializer>();

	register(serializer: EditorInputSerializer): IDisposable {
		validateSerializer(serializer);
		if (this.serializers.has(serializer.typeId)) {
			throw new Error(`Editor input serializer is already registered: ${serializer.typeId}`);
		}
		this.serializers.set(serializer.typeId, serializer);
		return toDisposable(() => {
			if (this.serializers.get(serializer.typeId) === serializer) this.serializers.delete(serializer.typeId);
		});
	}

	registerStatic(serializer: EditorInputSerializer): void {
		validateSerializer(serializer);
		if (this.serializers.has(serializer.typeId)) {
			throw new Error(`Editor input serializer is already registered: ${serializer.typeId}`);
		}
		this.serializers.set(serializer.typeId, serializer);
	}

	serialize(input: IResourceEditorInput): SerializedEditorInput {
		for (const serializer of this.serializers.values()) {
			if (!serializer.canSerialize(input)) continue;
			return Object.freeze({ typeId: serializer.typeId, value: serializer.serialize(input, this) });
		}
		return Object.freeze({ typeId: BaseEditorInputSerializer.typeId, value: serializeBaseEditorInput(input) });
	}

	deserialize(input: SerializedEditorInput): IResourceEditorInput {
		if (!isSerializedEditorInput(input)) throw new TypeError('Invalid serialized editor input');
		if (input.typeId === BaseEditorInputSerializer.typeId) return deserializeBaseEditorInput(input.value);
		const serializer = this.serializers.get(input.typeId);
		if (!serializer) throw new RangeError(`Unknown editor input serializer '${input.typeId}'`);
		return serializer.deserialize(input.value, this);
	}
}

export const EditorInputSerializers = new EditorInputSerializerRegistry();

const BaseEditorInputSerializer = Object.freeze({ typeId: 'workbench.editorInput.resource' });

function serializeBaseEditorInput(input: IResourceEditorInput): unknown {
	const icon = input.getIcon?.();
	let serializedIcon: string | { id: string; color?: string; } | undefined;
	if (icon instanceof URI) {
		serializedIcon = icon.toString();
	} else if (icon) {
		serializedIcon = { id: icon.id };
		if (icon.color) serializedIcon.color = icon.color.id;
	}
	return Object.freeze({
		resource: input.resource.toString(),
		...(serializedIcon === undefined ? {} : { icon: serializedIcon }),
		...(input.contentType === undefined ? {} : { contentType: input.contentType }),
		...(input.languageId === undefined ? {} : { languageId: input.languageId }),
		...(input.label === undefined ? {} : { label: input.label }),
		...(input.readOnly === undefined ? {} : { readOnly: input.readOnly }),
		...(input.showBreadcrumbs === undefined ? {} : { showBreadcrumbs: input.showBreadcrumbs }),
		...(input.initialText === undefined ? {} : { initialText: input.initialText }),
	});
}

function deserializeBaseEditorInput(value: unknown): IResourceEditorInput {
	const record = requireRecord(value, 'serialized editor input');
	const resource = requireString(record.resource, 'serialized editor resource');
	const contentType = optionalString(record.contentType, 'serialized editor content type');
	const languageId = optionalString(record.languageId, 'serialized editor language ID');
	const label = optionalString(record.label, 'serialized editor label');
	const readOnly = optionalBoolean(record.readOnly, 'serialized editor read-only state');
	const showBreadcrumbs = optionalBoolean(record.showBreadcrumbs, 'serialized editor breadcrumbs');
	const initialText = optionalString(record.initialText, 'serialized editor initial text');
	const icon = deserializeIcon(record.icon);
	return Object.freeze({
		resource: URI.parse(resource),
		...(icon === undefined ? {} : { getIcon: () => icon }),
		...(contentType === undefined ? {} : { contentType }),
		...(languageId === undefined ? {} : { languageId }),
		...(label === undefined ? {} : { label }),
		...(readOnly === undefined ? {} : { readOnly }),
		...(showBreadcrumbs === undefined ? {} : { showBreadcrumbs }),
		...(initialText === undefined ? {} : { initialText }),
	});
}

function deserializeIcon(value: unknown): ThemeIcon | URI | undefined {
	if (value === undefined) return undefined;
	if (typeof value === 'string') return URI.parse(value);
	const record = requireRecord(value, 'serialized editor icon');
	const id = requireString(record.id, 'serialized editor icon ID');
	const color = optionalString(record.color, 'serialized editor icon color');
	return Object.freeze({ id, ...(color === undefined ? {} : { color: Object.freeze({ id: color }) }) });
}

export function isSerializedEditorInput(value: unknown): value is SerializedEditorInput {
	return typeof value === 'object' && value !== null &&
		'typeId' in value && typeof value.typeId === 'string' && value.typeId.length > 0 &&
		'value' in value;
}

export function requireSerializedEditorInput(value: unknown, label: string): SerializedEditorInput {
	if (!isSerializedEditorInput(value)) throw new TypeError(`${label} must be a serialized editor input`);
	return value;
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
	return value as Record<string, unknown>;
}

export function requireString(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
	return value;
}

export function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
	return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`);
	return value;
}

function validateSerializer(serializer: EditorInputSerializer): void {
	if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(serializer.typeId)) {
		throw new TypeError(`Invalid editor input serializer ID: ${serializer.typeId}`);
	}
}

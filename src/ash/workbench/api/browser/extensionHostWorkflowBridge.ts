import { encodeHex, VSBuffer } from "../../../base/common/buffer.js";
import type { JsonValue } from "../../../platform/extensionHost/common/extensionHostApi.js";
import type { TaskProvider, TaskProviderTask, WorkspaceTaskGroup } from "../../services/tasks/common/taskService.js";
import type { TestProfileContribution, TestProfileProvider } from "../../services/testing/common/testingService.js";
import type { ExtensionHostProviderInvoker } from "./extensionHostLanguageBridge.js";

export function createExtensionHostTaskProvider(id: string, invoke: ExtensionHostProviderInvoker): TaskProvider {
	return Object.freeze({
		id,
		provideTasks: async (signal: AbortSignal): Promise<readonly TaskProviderTask[]> => normalizeTaskResult(await invoke("provideTasks", Object.freeze({}), signal)),
	});
}

export function createExtensionHostTestProfileProvider(id: string, invoke: ExtensionHostProviderInvoker, resolveTaskId: (providerRegistrationId: string, taskId: string) => string): TestProfileProvider {
	return Object.freeze({
		id,
		provideTestProfiles: async (signal: AbortSignal): Promise<readonly TestProfileContribution[]> => normalizeTestProfileResult(await invoke("provideTestProfiles", Object.freeze({}), signal), resolveTaskId),
	});
}

export function extensionHostWorkflowProviderId(extensionId: string, registrationId: string): string {
	return `extensionHost.${hexIdentifier(extensionId)}.${hexIdentifier(registrationId)}`;
}

export function extensionHostCanonicalTaskId(providerId: string, taskId: string): string {
	return `extension:${encodeURIComponent(providerId)}:${encodeURIComponent(taskId)}`;
}

function normalizeTaskResult(value: JsonValue): readonly TaskProviderTask[] {
	const result = exactObject(value, "Extension Task provider result", ["tasks"]);
	const tasks = boundedArray(result.tasks, "Extension Tasks", 10_000).map((task, index) => {
		const input = object(task, `Extension Task ${index}`);
		assertAllowedKeys(input, `Extension Task ${index}`, ["command", "detail", "group", "id", "label"], ["command", "group", "id", "label"]);
		return Object.freeze({
			id: boundedString(input.id, `Extension Task ${index} ID`, 256, false),
			label: boundedString(input.label, `Extension Task ${index} label`, 256, false),
			command: boundedString(input.command, `Extension Task ${index} command`, 32_768, false, false),
			group: textEnum(input.group, `Extension Task ${index} group`, ["build", "test", "run", "other"] as const) as WorkspaceTaskGroup,
			...(input.detail === undefined ? {} : { detail: boundedString(input.detail, `Extension Task ${index} detail`, 4096, true) }),
		});
	});
	assertUnique(tasks.map(task => task.id), "Extension Task IDs");
	return Object.freeze(tasks);
}

function normalizeTestProfileResult(value: JsonValue, resolveTaskId: (providerRegistrationId: string, taskId: string) => string): readonly TestProfileContribution[] {
	const result = exactObject(value, "Extension Test Profile provider result", ["profiles"]);
	const profiles = boundedArray(result.profiles, "Extension Test Profiles", 10_000).map((profile, index) => {
		const input = object(profile, `Extension Test Profile ${index}`);
		assertAllowedKeys(input, `Extension Test Profile ${index}`, ["detail", "id", "label", "taskId", "taskProviderRegistrationId"], ["id", "label", "taskId", "taskProviderRegistrationId"]);
		const taskReference = boundedString(input.taskId, `Extension Test Profile ${index} task ID`, 1024, false);
		const taskProviderRegistrationId = boundedString(input.taskProviderRegistrationId, `Extension Test Profile ${index} Task provider registration ID`, 256, false);
		return Object.freeze({
			id: boundedString(input.id, `Extension Test Profile ${index} ID`, 256, false),
			label: boundedString(input.label, `Extension Test Profile ${index} label`, 256, false),
			taskId: resolveTaskId(taskProviderRegistrationId, taskReference),
			...(input.detail === undefined ? {} : { detail: boundedString(input.detail, `Extension Test Profile ${index} detail`, 4096, true) }),
		});
	});
	assertUnique(profiles.map(profile => profile.id), "Extension Test Profile IDs");
	return Object.freeze(profiles);
}

function exactObject(value: JsonValue, owner: string, keys: readonly string[]): Record<string, JsonValue> {
	const result = object(value, owner);
	const actual = Object.keys(result).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${owner} has an invalid shape`);
	return result;
}

function object(value: JsonValue, owner: string): Record<string, JsonValue> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${owner} must be an object`);
	return value as Record<string, JsonValue>;
}

function assertAllowedKeys(value: Record<string, JsonValue>, owner: string, allowed: readonly string[], required: readonly string[]): void {
	const keys = Object.keys(value);
	if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new TypeError(`${owner} has an invalid shape`);
}

function boundedArray(value: JsonValue | undefined, owner: string, maximum: number): readonly JsonValue[] {
	if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${owner} is invalid`);
	return value;
}

function boundedString(value: JsonValue | undefined, owner: string, maximum: number, allowEmpty: boolean, trim = true): string {
	if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0) || value.length > maximum || value.includes("\0")) throw new TypeError(`${owner} is invalid`);
	return trim ? value.trim() : value;
}

function textEnum<const T extends readonly string[]>(value: JsonValue | undefined, owner: string, values: T): T[number] {
	if (typeof value !== "string" || !values.includes(value)) throw new TypeError(`${owner} is invalid`);
	return value as T[number];
}

function assertUnique(values: readonly string[], owner: string): void {
	if (new Set(values).size !== values.length) throw new TypeError(`${owner} must be unique`);
}

function hexIdentifier(value: string): string {
	return encodeHex(VSBuffer.fromString(value));
}

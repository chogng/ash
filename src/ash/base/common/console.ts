import { isPositiveSafeInteger } from './numbers.js';
import { isRecord } from './types.js';
import { URI } from './uri.js';

type ConsoleMethod = 'debug' | 'error' | 'info' | 'log' | 'warn';
type LocalConsoleMethod = Exclude<ConsoleMethod, 'log'>;
type ConsoleTarget = Pick<Console, LocalConsoleMethod>;

export interface IRemoteConsoleLog {
	type: string;
	severity: string;
	arguments: string;
}

export interface IStackArgument {
	__$stack: string;
}

export interface IStackFrame {
	uri: URI;
	line: number;
	column: number;
}

interface LocalConsoleLog {
	readonly severity: LocalConsoleMethod;
	readonly arguments: readonly [message: string, ...rest: unknown[]];
}

function isConsoleMethod(value: unknown): value is ConsoleMethod {
	return value === 'debug' || value === 'error' || value === 'info' || value === 'log' || value === 'warn';
}

export function isRemoteConsoleLog(value: unknown): value is IRemoteConsoleLog {
	return isRecord(value) && value.type === '__$console' && isConsoleMethod(value.severity) && typeof value.arguments === 'string';
}

function isStackArgument(value: unknown): value is IStackArgument {
	return isRecord(value) && typeof value.__$stack === 'string' && Object.keys(value).length === 1;
}

export function parse(entry: IRemoteConsoleLog): { args: unknown[]; stack?: string; } {
	try {
		const decoded: unknown = JSON.parse(entry.arguments);
		if (Array.isArray(decoded)) {
			const args: unknown[] = decoded;
			const last = args.at(-1);
			if (isStackArgument(last)) {
				args.pop();
				return { args, stack: last.__$stack };
			}
			return { args, stack: undefined };
		}
	} catch {
		// Preserve the original payload so a broken sender remains diagnosable.
	}
	return { args: ['Unable to log remote console arguments', entry.arguments], stack: undefined };
}

function firstStackLine(stack: string | undefined): string | undefined {
	return /^[ \t]*at [^\r\n]+/m.exec(stack ?? '')?.[0].trim();
}

export function getFirstFrame(entry: IRemoteConsoleLog): IStackFrame | undefined;
export function getFirstFrame(stack: string | undefined): IStackFrame | undefined;
export function getFirstFrame(entry: IRemoteConsoleLog | string | undefined): IStackFrame | undefined {
	const stack = typeof entry === 'string' || entry === undefined ? entry : parse(entry).stack;
	const frame = firstStackLine(stack);
	const location = frame?.replace(/^at (?:async )?/, '').replace(/^[^(/\\]*\((.*)\)$/, '$1');
	const match = location && /^(.+):(\d+):(\d+)$/.exec(location);
	if (!match) {
		return undefined;
	}
	const [, source, rawLine, rawColumn] = match;
	const line = Number(rawLine);
	const column = Number(rawColumn);
	if (!isPositiveSafeInteger(line) || !isPositiveSafeInteger(column)) {
		return undefined;
	}
	try {
		if (/^file:\/\//i.test(source)) {
			return { uri: URI.parse(source), line, column };
		}
		const path = /^(?:[a-z]:[/\\]|\\\\)/i.test(source) ? source.replaceAll('\\', '/') : source;
		return { uri: URI.file(path), line, column };
	} catch {
		return undefined;
	}
}

export function log(entry: IRemoteConsoleLog, label: string, target?: Pick<Console, ConsoleMethod>): void;
export function log(entry: LocalConsoleLog, label: string, target: ConsoleTarget): void;
export function log(entry: IRemoteConsoleLog | LocalConsoleLog, label: string, target: ConsoleTarget & Partial<Pick<Console, 'log'>> = console): void {
	if (!('type' in entry)) {
		const [message, ...rest] = entry.arguments;
		target[entry.severity](`[${label}] ${message}`, ...rest);
		return;
	}
	const { severity } = entry;
	if (!isConsoleMethod(severity) || typeof target[severity] !== 'function') {
		throw new Error('Unknown console method');
	}
	const { args, stack } = parse(entry);
	const [message, ...rest] = args;
	const frame = firstStackLine(stack);
	const location = frame ? [`(${frame})`] : [];
	const prefix = `%c[${label}]`;
	const labelStyle = 'color: blue';
	if (typeof message !== 'string') {
		target[severity](prefix, labelStyle, ...args, ...location);
	} else if (frame && rest.length === 0) {
		target[severity](`${prefix} %c${message} %c(${frame})`, labelStyle, 'color: ', 'color: grey');
	} else {
		target[severity](`${prefix} %c${message}`, labelStyle, 'color: ', ...rest, ...location);
	}
}

import { generateUuid } from '../../../../base/common/uuid.js';
import type { DesignShape, DesignShapeGeometry } from '../common/model/designDocument.js';

export function geometry(x: number, y: number, width: number, height: number, fill: string): DesignShapeGeometry {
	return { id: generateUuid(), x, y, width, height, fill, rotation: 0 };
}

export function text(x: number, y: number, width: number, value: string, fontSize: number, fill: string, fontWeight = 400): DesignShape {
	return { ...geometry(x, y, width, value.split('\n').length * fontSize * 1.3, fill), kind: 'text', text: value, fontSize, fontWeight };
}

export function frame(x: number, width: number, height: number, fill: string, name: string, children: readonly DesignShape[]): DesignShape {
	return { ...geometry(x, 0, width, height, fill), kind: 'frame', name, clip: true, children };
}

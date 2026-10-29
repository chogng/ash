/** A small image grid used by the transient glyph layer; the original image remains untouched. */
export class ImageSamples {
	private constructor(public readonly width: number, public readonly height: number, private readonly columns: number, private readonly rows: number, private readonly pixels: Uint8ClampedArray) { }

	static create(image: HTMLImageElement, width: number, height: number): ImageSamples | undefined {
		const canvas = image.ownerDocument.createElement('canvas');
		canvas.width = Math.min(64, Math.max(1, Math.ceil(width / 10)));
		canvas.height = Math.min(64, Math.max(1, Math.ceil(height / 10)));
		try {
			const context = canvas.getContext('2d', { willReadFrequently: true });
			if (!context) return undefined;
			context.drawImage(image, 0, 0, canvas.width, canvas.height);
			return new ImageSamples(width, height, canvas.width, canvas.height, context.getImageData(0, 0, canvas.width, canvas.height).data);
		} catch {
			// A cross-origin image may be displayed without granting access to its pixels.
			return undefined;
		} finally { canvas.width = canvas.height = 0; }
	}

	colorAt(x: number, y: number): string {
		const column = Math.min(this.columns - 1, Math.max(0, Math.floor(x * this.columns)));
		const row = Math.min(this.rows - 1, Math.max(0, Math.floor(y * this.rows)));
		const offset = (row * this.columns + column) * 4;
		return `rgba(${this.pixels[offset]}, ${this.pixels[offset + 1]}, ${this.pixels[offset + 2]}, ${this.pixels[offset + 3]! / 255})`;
	}
}

export interface ITextureFrame {
	readonly width: number;
	readonly height: number;
	readonly imageOpacity: number;
	readonly textureOpacity: number;
}

export interface ITextureRevealTiming {
	readonly loadingTime: number;
	readonly pace: { readonly duration: number; };
}

export interface ITextureRevealOptions {
	readonly image: HTMLImageElement;
	readonly samples: ImageSamples;
	readonly fromWidth: number;
	readonly fromHeight: number;
	readonly timing: ITextureRevealTiming;
	readonly duration: number;
	readonly onFrame: (frame: ITextureFrame) => void;
}

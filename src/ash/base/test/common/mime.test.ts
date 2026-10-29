import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { getExtensionForMimeType, getMediaMime, getMediaOrTextMime, isTextStreamMime, Mimes, normalizeMimeType } from '../../common/mime.js';

suite('MIME types', () => {
	test('looks up text and media extensions without depending on path casing', () => {
		assert.deepEqual([
			getMediaMime('/assets/photo.AVIF'),
			getMediaMime('/assets/video.MP4'),
			getMediaMime('/assets/report.pdf'),
			getMediaMime('/assets/readme.txt'),
			getMediaOrTextMime('/assets/readme.TXT'),
			getMediaOrTextMime('/assets/page.htm'),
			getMediaOrTextMime('/assets/data.JSON'),
			getMediaOrTextMime('/assets/photo.PNG'),
			getMediaOrTextMime('/assets/.hidden'),
			getMediaOrTextMime('/assets/unknown.extension'),
		], ['image/avif', 'video/mp4', 'application/pdf', undefined, Mimes.text, Mimes.html, 'application/json', 'image/png', undefined, undefined]);
	});

	test('assigns usable extensions to MIME aliases and parameterized representations', () => {
		assert.deepEqual([
			getExtensionForMimeType('image/jpg'),
			getExtensionForMimeType('image/jpeg'),
			getExtensionForMimeType('IMAGE/PNG;charset=utf-8'),
			getExtensionForMimeType('audio/mpeg'),
			getExtensionForMimeType('video/mp4'),
			getExtensionForMimeType(Mimes.text),
			getExtensionForMimeType('application/pdf'),
			getExtensionForMimeType('application/x-custom'),
		], ['.jpg', '.jpg', '.png', '.mp3', '.mp4', '.txt', '.pdf', undefined]);
	});

	test('preserves parameters and invalid input while normalizing the type and subtype', () => {
		assert.deepEqual([
			normalizeMimeType('TEXT/HTML;Charset=UTF-8'),
			normalizeMimeType('invalid'),
			normalizeMimeType('invalid', true),
			normalizeMimeType('text/♥', true),
			isTextStreamMime('application/vnd.code.notebook.stdout'),
			isTextStreamMime('application/vnd.code.notebook.stderr'),
			isTextStreamMime(Mimes.text),
		], ['text/html;Charset=UTF-8', 'invalid', undefined, 'text/♥', true, true, false]);
	});
});

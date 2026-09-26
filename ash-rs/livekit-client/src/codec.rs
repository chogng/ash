use crate::MediaError;
use oxideav_vp8::I420Frame;
use oxideav_vp8::KeyframeParams;
use oxideav_vp8::Vp8DecoderState;
use oxideav_vp8::Vp8InterStreamEncoder;
use screen_capture::CapturedFrame;

pub(crate) struct Planes {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) y: Vec<u8>,
    pub(crate) u: Vec<u8>,
    pub(crate) v: Vec<u8>,
}

impl Planes {
    pub(crate) fn as_frame(&self) -> I420Frame<'_> {
        I420Frame::packed(self.width, self.height, &self.y, &self.u, &self.v)
    }
}

pub(crate) fn capture_planes(frame: &CapturedFrame) -> Option<Planes> {
    let CapturedFrame::Rgba {
        data,
        width,
        height,
        stride,
        ..
    } = frame;
    let (w, h, stride) = (*width as usize, *height as usize, *stride as usize);
    if w == 0
        || h == 0
        || w > 8192
        || h > 8192
        || w.checked_mul(h)? > 16_777_216
        || stride < w.checked_mul(4)?
        || data.len() < stride.checked_mul(h)?
    {
        return None;
    }
    let chroma_width = w.div_ceil(2);
    let chroma_height = h.div_ceil(2);
    let mut planes = Planes {
        width: *width,
        height: *height,
        y: vec![0; w * h],
        u: vec![0; chroma_width * chroma_height],
        v: vec![0; chroma_width * chroma_height],
    };
    for row in 0..h {
        for col in 0..w {
            let pixel = row * stride + col * 4;
            let r = data[pixel] as i32;
            let g = data[pixel + 1] as i32;
            let b = data[pixel + 2] as i32;
            planes.y[row * w + col] =
                (((66 * r + 129 * g + 25 * b + 128) >> 8) + 16).clamp(0, 255) as u8;
            if row % 2 == 0 && col % 2 == 0 {
                let chroma = row / 2 * chroma_width + col / 2;
                planes.u[chroma] =
                    (((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128).clamp(0, 255) as u8;
                planes.v[chroma] =
                    (((112 * r - 94 * g - 18 * b + 128) >> 8) + 128).clamp(0, 255) as u8;
            }
        }
    }
    Some(planes)
}

pub(crate) struct VideoEncoder {
    dimensions: Option<(u32, u32)>,
    encoder: Option<Vp8InterStreamEncoder>,
    fps: u32,
}

impl VideoEncoder {
    pub(crate) fn new(fps: u32) -> Self {
        Self {
            dimensions: None,
            encoder: None,
            fps,
        }
    }

    pub(crate) fn encode(&mut self, frame: &Planes) -> Result<Vec<u8>, MediaError> {
        let dimensions = (frame.width, frame.height);
        if self.dimensions != Some(dimensions) {
            self.encoder = Vp8InterStreamEncoder::new(
                KeyframeParams::default(),
                u64::from(self.fps.max(1)) * 2,
            );
            self.dimensions = Some(dimensions);
        }
        self.encoder
            .as_mut()
            .ok_or(MediaError::ScreenShare)?
            .encode_frame(&frame.as_frame())
            .map(|encoded| encoded.bytes)
            .map_err(|_| MediaError::ScreenShare)
    }
}

pub(crate) struct VideoDecoder(Vp8DecoderState);

impl VideoDecoder {
    pub(crate) fn new() -> Self {
        Self(Vp8DecoderState::new())
    }

    pub(crate) fn decode(&mut self, encoded: &[u8]) -> Option<Planes> {
        // VP8 keyframe dimensions are untrusted and must be bounded before the decoder allocates planes.
        if encoded.first().is_some_and(|tag| tag & 1 == 0) {
            if encoded.len() < 10 || encoded[3..6] != [0x9d, 0x01, 0x2a] {
                return None;
            }
            let width = u16::from_le_bytes([encoded[6], encoded[7]]) & 0x3fff;
            let height = u16::from_le_bytes([encoded[8], encoded[9]]) & 0x3fff;
            if width == 0
                || height == 0
                || width > 8192
                || height > 8192
                || u32::from(width) * u32::from(height) > 16_777_216
            {
                return None;
            }
        }
        let decoded = self.0.decode_frame(encoded).ok()?;
        let pixels = u64::from(decoded.width) * u64::from(decoded.height);
        if decoded.width == 0
            || decoded.height == 0
            || decoded.width > 8192
            || decoded.height > 8192
            || pixels > 16_777_216
        {
            return None;
        }
        Some(Planes {
            width: decoded.width,
            height: decoded.height,
            y: decoded.y,
            u: decoded.u,
            v: decoded.v,
        })
    }
}

pub(crate) fn rgba(planes: &Planes) -> Vec<u8> {
    let width = planes.width as usize;
    let height = planes.height as usize;
    let chroma_width = width.div_ceil(2);
    let mut pixels = vec![0; width * height * 4];
    for row in 0..height {
        for col in 0..width {
            let luma = planes.y[row * width + col] as i32 - 16;
            let chroma = row / 2 * chroma_width + col / 2;
            let u = planes.u[chroma] as i32 - 128;
            let v = planes.v[chroma] as i32 - 128;
            let pixel = (row * width + col) * 4;
            pixels[pixel] = ((298 * luma + 409 * v + 128) >> 8).clamp(0, 255) as u8;
            pixels[pixel + 1] = ((298 * luma - 100 * u - 208 * v + 128) >> 8).clamp(0, 255) as u8;
            pixels[pixel + 2] = ((298 * luma + 516 * u + 128) >> 8).clamp(0, 255) as u8;
            pixels[pixel + 3] = 255;
        }
    }
    pixels
}

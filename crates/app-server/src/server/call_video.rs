use ash_app_server_protocol::protocol::call::CallScreenFrame;
use base64::Engine;
use livekit_client::ScreenFrame;
use std::collections::BTreeMap;
use std::time::Duration;

/// Latest frames only. Slow windows never grow the RPC notification queue.
#[derive(Default)]
pub(super) struct Screens {
    tracks: BTreeMap<String, (String, Option<ScreenFrame>)>,
}

impl Screens {
    pub fn add(&mut self, id: String, participant: String) -> Result<(), String> {
        if !self.tracks.contains_key(&id) && self.tracks.len() >= 8 {
            return Err("Too many shared screens".into());
        }
        self.tracks.entry(id).or_insert((participant, None));
        Ok(())
    }

    pub fn push(&mut self, frame: ScreenFrame) {
        if self
            .add(frame.track_id.clone(), frame.participant_id.clone())
            .is_err()
        {
            return;
        }
        let other_bytes: usize = self
            .tracks
            .iter()
            .filter(|(id, _)| **id != frame.track_id)
            .filter_map(|(_, (_, frame))| frame.as_ref())
            .map(|frame| frame.rgba.len())
            .sum();
        if other_bytes + frame.rgba.len() <= 64 * 1024 * 1024 {
            if let Some((_, slot)) = self.tracks.get_mut(&frame.track_id) {
                *slot = Some(frame);
            }
        }
    }

    pub fn remove(&mut self, id: &str) {
        self.tracks.remove(id);
    }
    pub fn remove_participant(&mut self, id: &str) {
        self.tracks.retain(|_, (participant, _)| participant != id);
    }
    pub fn clear(&mut self) {
        self.tracks.clear();
    }

    pub fn take(&mut self) -> (Vec<String>, Vec<ScreenFrame>) {
        let ids = self.tracks.keys().cloned().collect();
        let frames = self
            .tracks
            .values_mut()
            .filter_map(|(_, frame)| frame.take())
            .filter(|frame| frame.received_at.elapsed() <= Duration::from_millis(500))
            .collect();
        (ids, frames)
    }
}

pub(super) fn encode(frame: ScreenFrame) -> Result<CallScreenFrame, String> {
    let rgba = image::RgbaImage::from_raw(frame.width, frame.height, frame.rgba)
        .ok_or("Invalid video dimensions")?;
    let image = image::DynamicImage::ImageRgba8(rgba);
    let image = match frame.rotation {
        90 => image.rotate90(),
        180 => image.rotate180(),
        270 => image.rotate270(),
        _ => image,
    };
    let image = if image.width() > 1920 || image.height() > 1080 {
        image.thumbnail(1920, 1080)
    } else {
        image
    };
    let image = image.to_rgb8();
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 80)
        .encode_image(&image)
        .map_err(|error| error.to_string())?;
    if jpeg.len() > 2 * 1024 * 1024 {
        return Err("Video frame exceeds transport limit".into());
    }
    Ok(CallScreenFrame {
        track_id: frame.track_id,
        participant_id: frame.participant_id,
        jpeg: base64::engine::general_purpose::STANDARD.encode(jpeg),
    })
}

#[cfg(test)]
#[path = "call_video_tests.rs"]
mod tests;

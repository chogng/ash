use crate::host::clipboard::ClipboardImageFingerprint;
use crate::keymap::bindings;
use crate::render::RenderContext;
use crate::render::horizontal_margin;
use crate::widgets::key_hint;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;
use std::time::Duration;
use std::time::Instant;
use unicode_width::UnicodeWidthStr;

const TRANSIENT_TIP_DURATION: Duration = Duration::from_secs(5);
const FADE_DURATION: Duration = Duration::from_secs(2);

#[derive(Debug)]
pub(crate) struct TopTip {
    phase: TopTipPhase,
    now: Instant,
    // Fullscreen also expires the initial policy and navigation; inline keeps its stable hint.
    fullscreen_expires_at: Instant,
    notice: Option<Notice>,
    clipboard_image_expires_at: Option<Instant>,
    last_clipboard_image: Option<ClipboardImageFingerprint>,
}

#[derive(Debug)]
enum TopTipPhase {
    Navigation,
    Policy { expires_at: Instant },
    Hidden,
}

#[derive(Debug)]
struct Notice {
    text: String,
    expires_at: Instant,
}

impl TopTip {
    pub(crate) fn new() -> Self {
        let now = Instant::now();
        Self {
            phase: TopTipPhase::Navigation,
            now,
            fullscreen_expires_at: now + TRANSIENT_TIP_DURATION,
            notice: None,
            clipboard_image_expires_at: None,
            last_clipboard_image: None,
        }
    }

    pub(crate) fn show_policy_tip(&mut self, now: Instant) {
        self.now = now;
        self.fullscreen_expires_at = now + TRANSIENT_TIP_DURATION;
        self.phase = TopTipPhase::Policy {
            expires_at: now + TRANSIENT_TIP_DURATION,
        };
    }

    pub(crate) fn hide_navigation(&mut self) {
        if matches!(self.phase, TopTipPhase::Navigation) {
            self.phase = TopTipPhase::Hidden;
        }
    }

    pub(crate) fn reset(&mut self) {
        self.now = Instant::now();
        self.fullscreen_expires_at = self.now + TRANSIENT_TIP_DURATION;
        self.phase = TopTipPhase::Navigation;
    }

    pub(crate) fn show_notice(&mut self, text: String, now: Instant) {
        self.now = now;
        self.notice = Some(Notice {
            text,
            expires_at: now + TRANSIENT_TIP_DURATION,
        });
    }

    pub(crate) fn show_clipboard_image(
        &mut self,
        fingerprint: ClipboardImageFingerprint,
        now: Instant,
    ) {
        if self.last_clipboard_image == Some(fingerprint) {
            return;
        }
        self.now = now;
        self.last_clipboard_image = Some(fingerprint);
        self.clipboard_image_expires_at = Some(now + TRANSIENT_TIP_DURATION);
    }

    pub(crate) fn clipboard_image_pasted(&mut self, fingerprint: ClipboardImageFingerprint) {
        self.last_clipboard_image = Some(fingerprint);
        self.hide_clipboard_image();
    }

    pub(crate) fn hide_clipboard_image(&mut self) {
        self.clipboard_image_expires_at = None;
    }

    pub(crate) fn poll_fullscreen(&mut self, now: Instant) -> bool {
        let opacity = self.opacity();
        let changed = self.poll(now);
        changed || opacity != self.opacity()
    }

    pub(crate) fn poll(&mut self, now: Instant) -> bool {
        self.now = now;
        let notice_expired = self
            .notice
            .as_ref()
            .is_some_and(|notice| notice.expires_at <= now);
        if notice_expired {
            self.notice = None;
        }
        let clipboard_image_expired = self
            .clipboard_image_expires_at
            .is_some_and(|expires_at| expires_at <= now);
        if clipboard_image_expired {
            self.clipboard_image_expires_at = None;
        }
        let policy_expired = matches!(
            self.phase,
            TopTipPhase::Policy { expires_at } if expires_at <= now
        );
        if policy_expired {
            self.phase = TopTipPhase::Hidden;
        }
        notice_expired || clipboard_image_expired || policy_expired
    }

    #[cfg(test)]
    pub(crate) fn text<'a>(&'a self, tip: Option<&'a str>) -> Option<&'a str> {
        if let Some(notice) = self.notice.as_ref() {
            return Some(notice.text.as_str());
        }
        if self.clipboard_image_expires_at.is_some() {
            return Some(bindings::CLIPBOARD_HINTS.text());
        }
        match self.phase {
            TopTipPhase::Navigation => tip,
            TopTipPhase::Policy { .. } => Some(bindings::POLICY_HINTS.text()),
            TopTipPhase::Hidden => None,
        }
    }

    pub(crate) fn localized_text<'a>(
        &'a self,
        tip: Option<&'a str>,
        language: crate::nls::Language,
    ) -> Option<std::borrow::Cow<'a, str>> {
        if let Some(notice) = self.notice.as_ref() {
            return Some(crate::nls::localize(language, &notice.text));
        }
        if self.clipboard_image_expires_at.is_some() {
            return Some(std::borrow::Cow::Owned(
                bindings::CLIPBOARD_HINTS.localized_text(language),
            ));
        }
        match self.phase {
            TopTipPhase::Navigation => tip.map(|tip| crate::nls::localize(language, tip)),
            TopTipPhase::Policy { .. } => Some(std::borrow::Cow::Owned(
                bindings::POLICY_HINTS.localized_text(language),
            )),
            TopTipPhase::Hidden => None,
        }
    }

    fn opacity(&self) -> f32 {
        let expires_at = self
            .notice
            .as_ref()
            .map(|notice| notice.expires_at)
            .or(self.clipboard_image_expires_at)
            .unwrap_or(self.fullscreen_expires_at);
        let remaining = (expires_at.saturating_duration_since(self.now).as_secs_f32()
            / FADE_DURATION.as_secs_f32())
        .min(1.0);
        remaining * remaining * (3.0 - 2.0 * remaining)
    }

    pub(crate) fn draw_fullscreen(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        navigation: Option<&str>,
        policy: Line<'_>,
        context: RenderContext<'_>,
    ) {
        let opacity = self.opacity();
        if area.is_empty() || opacity == 0.0 {
            return;
        }
        let mut hint_area = area;
        if self.notice.is_none() && self.clipboard_image_expires_at.is_none() {
            let content = horizontal_margin(area, 2);
            let policy_width = policy.width() as u16;
            frame.render_widget(Paragraph::new(policy), content);
            let occupied = if policy_width == 0 {
                0
            } else {
                policy_width.saturating_add(3).min(area.width)
            };
            hint_area.x += occupied;
            hint_area.width -= occupied;
        }
        if let Some(text) = self.localized_text(navigation, context.language())
            && (self.notice.is_some()
                || self.clipboard_image_expires_at.is_some()
                || text.width() <= usize::from(horizontal_margin(hint_area, 2).width))
        {
            key_hint::draw_right(frame, hint_area, &text, context);
        }
        for y in area.y..area.bottom() {
            for x in area.x..area.right() {
                let cell = &mut frame.buffer_mut()[(x, y)];
                cell.set_style(context.fade_style(cell.style(), opacity));
            }
        }
    }
}

#[cfg(test)]
#[path = "top_tip_tests.rs"]
mod tests;

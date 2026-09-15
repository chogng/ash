use super::AppKeymap;
use super::AppUserBinding;
use super::bindings::AppKeybindingSpec;
use super::bindings::AppKeymapAction;
use super::bindings::AppKeymapContext;
use super::bindings::condition_matches;
use super::input::normalized_key;
use ash_keybinding::Chord;
use ash_keybinding::HostPlatform;
use ash_keybinding::KeyIdentity;
use ash_keybinding::KeySequence;
use ash_keybinding::KeyStroke;
use ash_keybinding::KeybindingResolver;
use ash_keybinding::ResolveResult;
use ash_keybinding::ShortcutModifiers;
use ash_keybinding::format_key_sequence;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use std::time::Duration;
use std::time::Instant;

pub(super) const KEY_CHORD_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct PendingChord {
    events: Vec<KeyStroke>,
    sequence: KeySequence,
    context: AppKeymapContext,
    started_at: Instant,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AppChordMatch {
    PassThrough,
    Pending,
    Command(AppKeymapAction),
    Consumed,
}

impl AppKeymap {
    pub(crate) fn route_chord(
        &mut self,
        key: &KeyEvent,
        context: AppKeymapContext,
        now: Instant,
    ) -> AppChordMatch {
        self.expire(context, now);
        if self.pending.is_some() && key.kind != KeyEventKind::Press {
            return AppChordMatch::Consumed;
        }
        if key.kind != KeyEventKind::Press {
            return AppChordMatch::PassThrough;
        }
        if self.pending.is_some() && super::bindings::CLOSE.matches(*key) {
            self.cancel_chord();
            return AppChordMatch::Consumed;
        }
        let Some(normalized) = normalized_key(key) else {
            self.pending = None;
            return AppChordMatch::PassThrough;
        };
        let had_pending = self.pending.is_some();
        let mut events = self
            .pending
            .as_ref()
            .map(|pending| pending.events.clone())
            .unwrap_or_default();
        let mut chords = self
            .pending
            .as_ref()
            .map(|pending| pending.sequence.chords().to_vec())
            .unwrap_or_default();
        events.push(normalized.stroke.clone());
        chords.push(normalized.chord.clone());
        if let Some(result) = self.resolve_chord_prefix(events, chords, context, now) {
            return result;
        }
        self.pending = None;
        if had_pending
            && let Some(result) = self.resolve_chord_prefix(
                vec![normalized.stroke],
                vec![normalized.chord],
                context,
                now,
            )
        {
            return result;
        }
        AppChordMatch::PassThrough
    }

    pub(crate) fn expire(&mut self, context: AppKeymapContext, now: Instant) -> bool {
        if self.pending.as_ref().is_some_and(|pending| {
            pending.context != context
                || now.saturating_duration_since(pending.started_at) >= KEY_CHORD_TIMEOUT
        }) {
            self.pending = None;
            return true;
        }
        false
    }

    pub(super) fn cancel_chord(&mut self) -> bool {
        self.pending.take().is_some()
    }

    pub(crate) fn pending_chord_label(&self) -> Option<String> {
        self.pending
            .as_ref()
            .map(|pending| format_key_sequence(&pending.sequence, self.platform))
    }

    fn resolve_chord_prefix(
        &mut self,
        events: Vec<KeyStroke>,
        chords: Vec<Chord>,
        context: AppKeymapContext,
        now: Instant,
    ) -> Option<AppChordMatch> {
        let resolver = KeybindingResolver::new(&self.chord_bindings, self.platform);
        match resolver.resolve(&context, &events, condition_matches) {
            ResolveResult::NoMatch => None,
            ResolveResult::PendingChord { .. } => {
                self.pending = Some(PendingChord {
                    events,
                    sequence: KeySequence::new(chords)
                        .expect("a pending TUI chord must contain one to four keys"),
                    context,
                    started_at: now,
                });
                Some(AppChordMatch::Pending)
            }
            ResolveResult::Command { command, .. } => {
                self.pending = None;
                Some(AppChordMatch::Command(command))
            }
            ResolveResult::Blocked { .. } => {
                self.pending = None;
                Some(AppChordMatch::Consumed)
            }
        }
    }
}

pub(super) fn validate_specs(specs: &[(AppKeybindingSpec, KeySequence)]) {
    for (binding, sequence) in specs {
        if sequence.chords().len() == 1 {
            continue;
        }
        assert!(
            !sequence.chords().iter().any(is_plain_escape),
            "fixed TUI chord `{}` cannot use plain Escape because Escape cancels pending chords",
            binding.keybinding,
        );
        let prefix = &sequence.chords()[0];
        assert!(
            is_safe_app_chord_prefix(prefix),
            "fixed TUI chord `{}` must use Control, Alt, Meta, primary, or a non-character prefix",
            binding.keybinding,
        );
        assert!(
            !specs.iter().any(|(_, candidate)| {
                candidate.chords().len() == 1 && candidate.chords().first() == Some(prefix)
            }),
            "fixed TUI chord `{}` shadows an application-level single-key binding",
            binding.keybinding,
        );
    }
}

pub(super) fn validate_user_bindings(
    rules: &[AppUserBinding],
    builtins: &[(AppKeybindingSpec, KeySequence)],
) -> Result<(), String> {
    let singles = builtins
        .iter()
        .map(|(_, sequence)| sequence)
        .chain(
            rules
                .iter()
                .map(|rule| &rule.keybinding)
                .filter(|sequence| sequence.chords().len() == 1),
        )
        .collect::<Vec<_>>();
    for rule in rules {
        let sequence = &rule.keybinding;
        if sequence.chords().len() == 1 {
            continue;
        }
        if sequence.chords().iter().any(is_plain_escape) {
            return Err(format!(
                "user chord `{}` cannot use plain Escape because Escape cancels pending chords",
                format_key_sequence(sequence, HostPlatform::current())
            ));
        }
        let prefix = &sequence.chords()[0];
        if !is_safe_app_chord_prefix(prefix) {
            return Err(format!(
                "user chord `{}` must use Control, Alt, Meta, primary, or a non-character prefix",
                format_key_sequence(sequence, HostPlatform::current())
            ));
        }
        if singles
            .iter()
            .any(|candidate| candidate.chords().first() == Some(prefix))
        {
            return Err(format!(
                "user chord `{}` shadows an application-level single-key binding",
                format_key_sequence(sequence, HostPlatform::current())
            ));
        }
    }
    Ok(())
}

fn is_plain_escape(chord: &Chord) -> bool {
    chord.modifiers() == ShortcutModifiers::none()
        && matches!(
            chord.key(),
            KeyIdentity::Logical(key) if key.as_str() == "escape"
        )
}

fn is_safe_app_chord_prefix(chord: &Chord) -> bool {
    let modifiers = chord.modifiers();
    let character_key = matches!(
        chord.key(),
        KeyIdentity::Logical(key) if key.as_str().chars().count() == 1
    );
    if !character_key {
        return true;
    }
    let control_or_primary = modifiers.uses_control() || modifiers.uses_primary();
    let alt = modifiers.uses_alt();
    let meta = modifiers.uses_meta();
    (control_or_primary || alt || meta) && !(control_or_primary && alt)
}

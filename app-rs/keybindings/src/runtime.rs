use std::time::Duration;
use std::time::Instant;

use ash_keybinding::BindingPriority;
use ash_keybinding::BindingSet;
use ash_keybinding::BindingSource;
use ash_keybinding::HostPlatform;
use ash_keybinding::KeySequence;
use ash_keybinding::KeyStroke;
use ash_keybinding::KeybindingResolver;
use ash_keybinding::ResolveResult;
use zui::input::KeyEvent;
use zui::input::ModifiersState;

use crate::catalog::KeybindingCatalog;
use crate::input::key_stroke;

/// Maximum time allowed between strokes of one pending chord.
pub const CHORD_TIMEOUT: Duration = Duration::from_millis(1_500);

/// A user-provided command or blocker rule after JSON validation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserBinding<C: KeybindingCatalog> {
    pub keybinding: KeySequence,
    pub target: UserBindingTarget<C::Command>,
    pub when: C::Condition,
    pub when_source: Option<String>,
}

/// The action a user binding contributes to the resolver.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UserBindingTarget<Command> {
    Command(Command),
    Block,
}

/// The application-facing result of resolving one platform key event.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KeybindingResolution<Command> {
    NoMatch,
    Command(Command),
    Consumed,
}

/// Keybinding runtime parameterized by an application command/context catalog.
pub struct Keybindings<C: KeybindingCatalog> {
    bindings: BindingSet<C::Condition, C::Command>,
    platform: HostPlatform,
    user_bindings: Vec<UserBinding<C>>,
    pending: Vec<KeyStroke>,
    pending_keybinding: Option<KeySequence>,
    chord_deadline: Option<Instant>,
}

impl<C: KeybindingCatalog> Default for Keybindings<C> {
    fn default() -> Self {
        Self::for_platform(HostPlatform::current())
    }
}

impl<C: KeybindingCatalog> Keybindings<C> {
    pub fn for_platform(platform: HostPlatform) -> Self {
        Self {
            bindings: C::builtin_bindings(platform),
            platform,
            user_bindings: Vec::new(),
            pending: Vec::new(),
            pending_keybinding: None,
            chord_deadline: None,
        }
    }

    pub fn resolve(
        &mut self,
        event: &KeyEvent,
        modifiers: ModifiersState,
        context: &C::Context,
    ) -> KeybindingResolution<C::Command> {
        let Some(stroke) = key_stroke(event, modifiers) else {
            return KeybindingResolution::NoMatch;
        };
        self.resolve_stroke_at(&stroke, context, Instant::now())
    }

    pub fn resolve_stroke(
        &mut self,
        stroke: &KeyStroke,
        context: &C::Context,
    ) -> KeybindingResolution<C::Command> {
        self.resolve_stroke_at(stroke, context, Instant::now())
    }

    pub fn resolve_stroke_at(
        &mut self,
        stroke: &KeyStroke,
        context: &C::Context,
        now: Instant,
    ) -> KeybindingResolution<C::Command> {
        self.advance_chord(now);
        let was_pending = !self.pending.is_empty();
        self.pending.push(stroke.clone());
        let resolver = KeybindingResolver::new(&self.bindings, self.platform);
        match resolver.resolve(context, &self.pending, C::condition_matches) {
            ResolveResult::NoMatch => {
                self.cancel_chord();
                if was_pending {
                    KeybindingResolution::Consumed
                } else {
                    KeybindingResolution::NoMatch
                }
            }
            ResolveResult::Command { command, .. } => {
                self.cancel_chord();
                KeybindingResolution::Command(command)
            }
            ResolveResult::PendingChord { keybinding } => {
                self.pending_keybinding = Some(keybinding);
                self.chord_deadline = Some(now + CHORD_TIMEOUT);
                KeybindingResolution::Consumed
            }
            ResolveResult::Blocked { .. } => {
                self.cancel_chord();
                KeybindingResolution::Consumed
            }
        }
    }

    pub fn advance_chord(&mut self, now: Instant) -> bool {
        let expired = self.chord_deadline.is_some_and(|deadline| now >= deadline);
        if expired {
            self.cancel_chord();
        }
        expired
    }

    pub fn cancel_chord(&mut self) {
        self.pending.clear();
        self.pending_keybinding = None;
        self.chord_deadline = None;
    }

    pub const fn chord_deadline(&self) -> Option<Instant> {
        self.chord_deadline
    }

    pub fn pending_keybinding(&self) -> Option<(&KeySequence, usize)> {
        self.pending_keybinding
            .as_ref()
            .map(|keybinding| (keybinding, self.pending.len()))
    }

    pub const fn platform(&self) -> HostPlatform {
        self.platform
    }

    pub fn binding_for_command(&self, command: C::Command) -> Option<&KeySequence> {
        self.user_bindings
            .iter()
            .rev()
            .find_map(|binding| match binding.target {
                UserBindingTarget::Command(candidate) if candidate == command => {
                    Some(&binding.keybinding)
                }
                UserBindingTarget::Command(_) | UserBindingTarget::Block => None,
            })
            .or_else(|| C::default_keybinding(command))
    }

    pub fn replace_user_bindings(&mut self, rules: Vec<UserBinding<C>>) {
        let mut bindings = C::builtin_bindings(self.platform);
        for rule in &rules {
            match rule.target {
                UserBindingTarget::Command(command) => bindings.register_command(
                    rule.keybinding.clone(),
                    command,
                    rule.when.clone(),
                    BindingSource::User,
                    BindingPriority::NORMAL,
                ),
                UserBindingTarget::Block => bindings.register_blocker(
                    rule.keybinding.clone(),
                    rule.when.clone(),
                    BindingSource::User,
                    BindingPriority::NORMAL,
                ),
            }
        }
        self.bindings = bindings;
        self.user_bindings = rules;
        self.cancel_chord();
    }
}

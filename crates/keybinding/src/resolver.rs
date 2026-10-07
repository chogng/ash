use crate::HostPlatform;
use crate::KeySequence;
use crate::KeyStroke;
use crate::binding::BindingRule;
use crate::binding::BindingSet;
use crate::binding::BindingTarget;

/// Result of resolving an ordered input prefix against the active rules.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResolveResult<A> {
    NoMatch,
    PendingChord { keybinding: KeySequence },
    Command { command: A, keybinding: KeySequence },
    Blocked { keybinding: KeySequence },
}

/// Resolves active shortcut rules without owning product context or command execution.
pub struct KeybindingResolver<'a, C, A> {
    bindings: &'a BindingSet<C, A>,
    platform: HostPlatform,
}

impl<'a, C, A> KeybindingResolver<'a, C, A> {
    pub const fn new(bindings: &'a BindingSet<C, A>, platform: HostPlatform) -> Self {
        Self { bindings, platform }
    }
}

impl<C, A: Clone> KeybindingResolver<'_, C, A> {
    pub fn resolve<T>(
        &self,
        context: &T,
        events: &[KeyStroke],
        condition_matches: impl Fn(&C, &T) -> bool,
    ) -> ResolveResult<A> {
        if events.is_empty() {
            return ResolveResult::NoMatch;
        }
        let winner = self
            .bindings
            .rules
            .iter()
            .filter(|rule| {
                condition_matches(&rule.when, context)
                    && rule.keybinding.matches_prefix(events, self.platform)
            })
            .max_by_key(|rule| precedence(rule));
        let Some(winner) = winner else {
            return ResolveResult::NoMatch;
        };
        if winner.keybinding.chords().len() > events.len() {
            return ResolveResult::PendingChord {
                keybinding: winner.keybinding.clone(),
            };
        }
        match &winner.target {
            BindingTarget::Command(command) => ResolveResult::Command {
                command: command.clone(),
                keybinding: winner.keybinding.clone(),
            },
            BindingTarget::Block => ResolveResult::Blocked {
                keybinding: winner.keybinding.clone(),
            },
        }
    }
}

fn precedence<C, A>(rule: &BindingRule<C, A>) -> (u8, crate::BindingPriority, u64) {
    (rule.source.precedence(), rule.priority, rule.order)
}

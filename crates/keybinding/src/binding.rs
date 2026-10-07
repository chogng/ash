use crate::KeySequence;

/// Origin used before explicit priority and registration order are compared.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BindingSource {
    Builtin,
    Workbench,
    User,
}

impl BindingSource {
    pub(crate) const fn precedence(self) -> u8 {
        match self {
            Self::Builtin => 0,
            Self::Workbench => 1,
            Self::User => 2,
        }
    }
}

/// Explicit precedence within one shortcut source.
#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd)]
pub struct BindingPriority(i32);

impl BindingPriority {
    pub const NORMAL: Self = Self(0);

    pub const fn new(value: i32) -> Self {
        Self(value)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum BindingTarget<A> {
    Command(A),
    Block,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BindingRule<C, A> {
    pub(crate) keybinding: KeySequence,
    pub(crate) target: BindingTarget<A>,
    pub(crate) when: C,
    pub(crate) source: BindingSource,
    pub(crate) priority: BindingPriority,
    pub(crate) order: u64,
}

/// Ordered shortcut declarations for one product command domain.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BindingSet<C, A> {
    pub(crate) rules: Vec<BindingRule<C, A>>,
    next_order: u64,
}

impl<C, A> Default for BindingSet<C, A> {
    fn default() -> Self {
        Self {
            rules: Vec::new(),
            next_order: 1,
        }
    }
}

impl<C, A> BindingSet<C, A> {
    pub fn register_command(
        &mut self,
        keybinding: KeySequence,
        command: A,
        when: C,
        source: BindingSource,
        priority: BindingPriority,
    ) {
        self.register(
            keybinding,
            BindingTarget::Command(command),
            when,
            source,
            priority,
        );
    }

    pub fn register_blocker(
        &mut self,
        keybinding: KeySequence,
        when: C,
        source: BindingSource,
        priority: BindingPriority,
    ) {
        self.register(keybinding, BindingTarget::Block, when, source, priority);
    }

    fn register(
        &mut self,
        keybinding: KeySequence,
        target: BindingTarget<A>,
        when: C,
        source: BindingSource,
        priority: BindingPriority,
    ) {
        let order = self.next_order;
        self.next_order = self.next_order.saturating_add(1);
        self.rules.push(BindingRule {
            keybinding,
            target,
            when,
            source,
            priority,
            order,
        });
    }
}

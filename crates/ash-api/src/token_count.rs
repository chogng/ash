/// Input-token count returned by a provider preflight endpoint.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InputTokenCount(u64);

impl InputTokenCount {
    pub const fn new(tokens: u64) -> Self {
        Self(tokens)
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

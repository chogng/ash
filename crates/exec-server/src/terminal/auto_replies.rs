//! Bounded exact-byte matchers owned by a single attached PTY lease.

use super::TerminalAutoReply;
use super::TerminalError;
use std::collections::HashSet;
use std::time::Duration;
use std::time::Instant;

const MAX_RULES: usize = 32;
const MAX_RULE_BYTES: usize = 4096;
const MAX_TOTAL_BYTES: usize = 64 * 1024;
const REPLY_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Default)]
pub(super) struct AutoReplies {
    rules: Vec<Rule>,
}

struct Rule {
    pattern: Vec<u8>,
    reply: Vec<u8>,
    prefixes: Vec<usize>,
    matched: usize,
    last_reply: Option<Instant>,
}

impl AutoReplies {
    pub(super) fn new(rules: Vec<TerminalAutoReply>) -> Result<Self, TerminalError> {
        let mut total = 0_usize;
        let mut matches = HashSet::new();
        if rules.len() > MAX_RULES {
            return Err(TerminalError::InvalidInput);
        }
        let mut compiled = Vec::with_capacity(rules.len());
        for rule in rules {
            total = total.saturating_add(rule.match_text.len() + rule.reply.len());
            if rule.match_text.is_empty()
                || rule.match_text.len() > MAX_RULE_BYTES
                || rule.reply.is_empty()
                || rule.reply.len() > MAX_RULE_BYTES
                || total > MAX_TOTAL_BYTES
                || !matches.insert(rule.match_text.clone())
            {
                return Err(TerminalError::InvalidInput);
            }
            let pattern = rule.match_text.into_bytes();
            // The prefix table retains at most a pattern's length, including
            // when PTY reads split UTF-8 or contain repeated partial prefixes.
            let mut prefixes = vec![0; pattern.len()];
            let mut matched = 0;
            for index in 1..pattern.len() {
                while matched > 0 && pattern[index] != pattern[matched] {
                    matched = prefixes[matched - 1];
                }
                if pattern[index] == pattern[matched] {
                    matched += 1;
                }
                prefixes[index] = matched;
            }
            compiled.push(Rule {
                pattern,
                reply: rule.reply.into_bytes(),
                prefixes,
                matched: 0,
                last_reply: None,
            });
        }
        Ok(Self { rules: compiled })
    }

    pub(super) fn clear(&mut self) {
        self.rules.clear();
    }

    pub(super) fn replace(&mut self, mut replacement: Self) {
        // A startup install and a later configuration projection may contain the
        // same rules. Preserve partial matches and cooldowns for unchanged rules.
        for rule in &mut replacement.rules {
            if let Some(previous) = self
                .rules
                .iter()
                .find(|previous| previous.pattern == rule.pattern && previous.reply == rule.reply)
            {
                rule.matched = previous.matched;
                rule.last_reply = previous.last_reply;
            }
        }
        *self = replacement;
    }

    pub(super) fn process(
        &mut self,
        bytes: &[u8],
        now: Instant,
        mut send: impl FnMut(&[u8]) -> bool,
    ) {
        for rule in &mut self.rules {
            for byte in bytes {
                while rule.matched > 0 && *byte != rule.pattern[rule.matched] {
                    rule.matched = rule.prefixes[rule.matched - 1];
                }
                if *byte == rule.pattern[rule.matched] {
                    rule.matched += 1;
                }
                if rule.matched == rule.pattern.len() {
                    rule.matched = rule.prefixes[rule.matched - 1];
                    if rule
                        .last_reply
                        .is_none_or(|last| now.duration_since(last) >= REPLY_INTERVAL)
                        && send(&rule.reply)
                    {
                        rule.last_reply = Some(now);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "auto_replies_tests.rs"]
mod tests;

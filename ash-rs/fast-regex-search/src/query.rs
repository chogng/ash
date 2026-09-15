use crate::FastRegexError;
use regex_syntax::ParserBuilder;
use regex_syntax::hir::Class;
use regex_syntax::hir::ClassBytes;
use regex_syntax::hir::ClassBytesRange;
use regex_syntax::hir::ClassUnicode;
use regex_syntax::hir::ClassUnicodeRange;
use regex_syntax::hir::Hir;
use regex_syntax::hir::HirKind;
use regex_syntax::hir::literal::ExtractKind;
use regex_syntax::hir::literal::Extractor;

/// Necessary text constraints, evaluated against the ASCII-folded index.
/// `All` imposes no constraint; only the full regex verifier determines a match.
#[derive(Debug, Eq, PartialEq)]
pub(crate) enum Plan {
    All,
    Literal(Vec<u8>),
    And(Vec<Plan>),
    Or(Vec<Plan>),
}

pub(crate) fn plan(expression: &str, sensitive: bool) -> Result<Plan, FastRegexError> {
    let hir = ParserBuilder::new()
        .case_insensitive(!sensitive)
        .build()
        .parse(expression)
        .map_err(|error| regex::Error::Syntax(error.to_string()))?;
    Ok(required(&fold_ascii(hir)))
}

// Apply folding *after* parsing flags and Unicode case equivalences. For example,
// /kelvin/i requires either "kelvin" or "Kelvin" in the folded corpus. Lowercasing
// the query before parsing would incorrectly exclude the second spelling.
fn fold_ascii(hir: Hir) -> Hir {
    match hir.into_kind() {
        HirKind::Literal(literal) => Hir::literal(literal.0.to_ascii_lowercase()),
        HirKind::Class(Class::Unicode(class)) => {
            let mut ranges = Vec::new();
            for range in class.ranges() {
                for byte in range.start() as u32..=(range.end() as u32).min(127) {
                    let folded = (byte as u8).to_ascii_lowercase() as char;
                    ranges.push(ClassUnicodeRange::new(folded, folded));
                }
                if range.end() > '\u{7f}' {
                    ranges.push(ClassUnicodeRange::new(
                        range.start().max('\u{80}'),
                        range.end(),
                    ));
                }
            }
            Hir::class(Class::Unicode(ClassUnicode::new(ranges)))
        }
        HirKind::Class(Class::Bytes(class)) => {
            let ranges = class.ranges().iter().flat_map(|range| {
                (u16::from(range.start())..=u16::from(range.end())).map(|byte| {
                    let folded = (byte as u8).to_ascii_lowercase();
                    ClassBytesRange::new(folded, folded)
                })
            });
            Hir::class(Class::Bytes(ClassBytes::new(ranges)))
        }
        HirKind::Concat(children) => Hir::concat(children.into_iter().map(fold_ascii).collect()),
        HirKind::Alternation(children) => {
            Hir::alternation(children.into_iter().map(fold_ascii).collect())
        }
        HirKind::Capture(mut capture) => {
            capture.sub = Box::new(fold_ascii(*capture.sub));
            Hir::capture(capture)
        }
        HirKind::Repetition(mut repetition) => {
            repetition.sub = Box::new(fold_ascii(*repetition.sub));
            Hir::repetition(repetition)
        }
        HirKind::Look(look) => Hir::look(look),
        HirKind::Empty => Hir::empty(),
    }
}

fn required(hir: &Hir) -> Plan {
    match hir.kind() {
        HirKind::Literal(literal) => literal_plan(&literal.0),
        HirKind::Capture(capture) => required(&capture.sub),
        HirKind::Repetition(repetition) if repetition.min > 0 => all(vec![
            extracted(hir, ExtractKind::Prefix),
            extracted(hir, ExtractKind::Suffix),
            required(&repetition.sub),
        ]),
        HirKind::Alternation(children) => any(children.iter().map(required).collect()),
        HirKind::Concat(children) => {
            // Prefix/suffix extraction joins literals across small classes or
            // alternations. Recursing also finds mandatory text in the middle.
            let mut plans = vec![
                extracted(hir, ExtractKind::Prefix),
                extracted(hir, ExtractKind::Suffix),
            ];
            plans.extend(children.iter().map(required));
            all(plans)
        }
        _ => Plan::All,
    }
}

fn extracted(hir: &Hir, kind: ExtractKind) -> Plan {
    let mut extractor = Extractor::new();
    extractor.kind(kind);
    let sequence = extractor.extract(hir);
    match sequence.literals() {
        Some(literals) if !literals.is_empty() => any(literals
            .iter()
            .map(|literal| literal_plan(literal.as_bytes()))
            .collect()),
        _ => Plan::All,
    }
}

fn literal_plan(bytes: &[u8]) -> Plan {
    if bytes.len() < 3 {
        Plan::All
    } else {
        Plan::Literal(bytes.to_vec())
    }
}

fn all(plans: Vec<Plan>) -> Plan {
    let mut required = Vec::new();
    for plan in plans {
        if plan != Plan::All && !required.contains(&plan) {
            required.push(plan);
        }
    }
    match required.len() {
        0 => Plan::All,
        1 => required.pop().unwrap(),
        _ => Plan::And(required),
    }
}

fn any(mut plans: Vec<Plan>) -> Plan {
    if plans.is_empty() || plans.contains(&Plan::All) {
        Plan::All
    } else if plans.len() == 1 {
        plans.pop().unwrap()
    } else {
        Plan::Or(plans)
    }
}

use ash_fast_regex_search::FastRegexError;
use regex::Regex;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::time::Instant;

#[path = "algorithms/ngram.rs"]
mod ngram;
#[path = "../src/query.rs"]
mod query;

// Reuse the production extraction code; persistence helpers are unused here.
// Cargo checks harness-free benches with cfg(test), but excludes #[test] bodies.
#[allow(dead_code, unused_imports)]
#[path = "../src/trigram.rs"]
mod trigram;

enum Constraint {
    All,
    Literal {
        sparse: Vec<u64>,
        all_sparse: Vec<u64>,
        trigrams: Vec<(u32, Option<u8>)>,
    },
    And(Vec<Self>),
    Or(Vec<Self>),
}
impl Constraint {
    fn from(plan: query::Plan) -> Self {
        match plan {
            query::Plan::All => Self::All,
            query::Plan::Literal(bytes) => Self::Literal {
                sparse: ngram::covering_ngrams(&bytes),
                all_sparse: ngram::sparse_ngrams(&bytes),
                trigrams: bytes
                    .windows(3)
                    .enumerate()
                    .map(|(i, w)| {
                        (
                            u32::from_be_bytes([0, w[0], w[1], w[2]]),
                            bytes.get(i + 3).copied(),
                        )
                    })
                    .collect(),
            },
            query::Plan::And(parts) => Self::And(parts.into_iter().map(Self::from).collect()),
            query::Plan::Or(parts) => Self::Or(parts.into_iter().map(Self::from).collect()),
        }
    }
    fn accepts(
        &self,
        sparse: &[u64],
        tri: &std::collections::BTreeMap<u32, u8>,
        mode: usize,
    ) -> bool {
        match self {
            Self::All => true,
            Self::Literal {
                sparse: required,
                all_sparse,
                trigrams,
            } => {
                if mode == 0 {
                    required.iter().all(|g| sparse.binary_search(g).is_ok())
                } else if mode == 3 {
                    all_sparse.iter().all(|g| sparse.binary_search(g).is_ok())
                } else {
                    trigrams.iter().all(|(g, next)| {
                        tri.get(g).is_some_and(|m| {
                            mode == 1 || next.is_none_or(|byte| *m & following_bit(byte) != 0)
                        })
                    })
                }
            }
            Self::And(parts) => parts.iter().all(|p| p.accepts(sparse, tri, mode)),
            Self::Or(parts) => parts.iter().any(|p| p.accepts(sparse, tri, mode)),
        }
    }
}

fn following_bit(byte: u8) -> u8 {
    1 << ((byte.wrapping_mul(0x9e) >> 5) & 7)
}

fn extract_masks(bytes: &[u8]) -> std::collections::BTreeMap<u32, u8> {
    trigram::extract(bytes)
        .into_iter()
        .map(|g| (trigram::key(g) as u32, trigram::mask(g)))
        .collect()
}

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() < 3 {
        eprintln!(
            "usage: cargo bench -p ash-fast-regex-search --bench algorithms -- EVAL_ROOT CORPUS"
        );
        std::process::exit(2);
    }
    let base = Path::new(&args[1]);
    let name = &args[2];
    let manifest: Value = serde_json::from_slice(
        &fs::read(base.join("manifests").join(format!("{name}.json"))).unwrap(),
    )
    .unwrap();
    let queries: Vec<Value> = serde_json::from_slice(
        &fs::read(base.join("queries").join(format!("{name}.json"))).unwrap(),
    )
    .unwrap();
    let plans = queries
        .iter()
        .map(|q| {
            let raw = q["pattern"].as_str().unwrap();
            let expression = if q["kind"] == "literal" {
                regex::escape(raw)
            } else {
                raw.to_owned()
            };
            (
                Constraint::from(query::plan(&expression, true).unwrap()),
                Regex::new(&expression).unwrap(),
            )
        })
        .collect::<Vec<_>>();
    let mut counts = vec![[0usize; 5]; plans.len()];
    let mut extraction = [0u128; 2];
    let mut postings = [0usize; 2];
    let mut sparse_vocabulary = BTreeSet::new();
    let mut tri_vocabulary = BTreeSet::new();
    let mut false_negatives = Vec::new();
    for (i, entry) in manifest["entries"].as_array().unwrap().iter().enumerate() {
        let relative = entry[0].as_str().unwrap();
        let content = fs::read_to_string(base.join("corpora").join(name).join(relative)).unwrap();
        let folded = content.as_bytes().to_ascii_lowercase();
        let sparse;
        let tri;
        if i % 2 == 0 {
            let start = Instant::now();
            sparse = ngram::sparse_ngrams(&folded);
            extraction[0] += start.elapsed().as_nanos();
            let start = Instant::now();
            tri = extract_masks(&folded);
            extraction[1] += start.elapsed().as_nanos();
        } else {
            let start = Instant::now();
            tri = extract_masks(&folded);
            extraction[1] += start.elapsed().as_nanos();
            let start = Instant::now();
            sparse = ngram::sparse_ngrams(&folded);
            extraction[0] += start.elapsed().as_nanos();
        }
        postings[0] += sparse.len();
        postings[1] += tri.len();
        sparse_vocabulary.extend(sparse.iter().copied());
        tri_vocabulary.extend(tri.keys().copied());
        for (j, (plan, matcher)) in plans.iter().enumerate() {
            let matched = content
                .strip_prefix('\u{feff}')
                .unwrap_or(&content)
                .split_terminator('\n')
                .any(|line| matcher.is_match(line));
            counts[j][4] += usize::from(matched);
            for mode in 0..4 {
                let accepted = plan.accepts(&sparse, &tri, mode);
                counts[j][mode] += usize::from(accepted);
                if matched && !accepted {
                    false_negatives
                        .push(serde_json::json!({"file":relative,"query":queries[j],"mode":mode}));
                }
            }
        }
        if i % 10000 == 9999 {
            eprintln!("{name}: {} files", i + 1);
        }
    }
    let rows=queries.into_iter().zip(counts).map(|(q,c)|serde_json::json!({"query":q,"sparse":c[0],"trigram":c[1],"trigram_masks":c[2],"sparse_all":c[3],"matching_files":c[4]})).collect::<Vec<_>>();
    let result = serde_json::json!({"name":name,"files":manifest["files"],"bytes":manifest["bytes"],"extraction_ns":extraction,"postings":postings,"vocabulary":[sparse_vocabulary.len(),tri_vocabulary.len()],"false_negatives":false_negatives,"cases":rows,"frequency_digest":format!("{:x?}",ngram::bigram_frequency_digest())});
    println!("{result}");
}

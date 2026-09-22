use std::collections::HashMap;
use std::hint::black_box;
use std::time::Duration;
use std::time::Instant;

use prost::Message;

use super::EmbeddedClassifier;
use super::MODEL_BYTES;
use super::ModelProto;

fn unprepared() -> EmbeddedClassifier {
    let mut classifier = EmbeddedClassifier::load().unwrap();
    classifier.model = ModelProto::decode(MODEL_BYTES).unwrap();
    classifier.weights = HashMap::new();
    classifier
}

#[test]
fn prepared_weights_preserve_probabilities_across_inputs_and_threads() {
    let prepared = EmbeddedClassifier::load().unwrap();
    let original = unprepared();
    let inputs = [
        "git status".to_owned(),
        "git status 是做什么的".to_owned(),
        "帮我总结一下这个目录".to_owned(),
        "explain this command and its output ".repeat(24),
    ];
    std::thread::scope(|scope| {
        for input in &inputs {
            let prepared = &prepared;
            let expected = original.run_inference(input).unwrap();
            scope.spawn(move || {
                for _ in 0..3 {
                    let actual = prepared.run_inference(input).unwrap();
                    assert_eq!(actual.route, expected.route);
                    assert_eq!(actual.source, expected.source);
                    assert!((actual.confidence - expected.confidence).abs() < 0.000_001);
                }
            });
        }
    });
}

#[test]
#[ignore = "manual comparison of cached weights against upstream simple_eval"]
fn inference_latency() {
    fn percentile(samples: &mut [Duration], percentile: usize) -> Duration {
        samples.sort_unstable();
        samples[(samples.len() - 1) * percentile / 100]
    }
    let started = Instant::now();
    let prepared = EmbeddedClassifier::load().unwrap();
    let initialization = started.elapsed();
    let original = unprepared();
    let inputs = [
        "git status".to_owned(),
        "git status 是做什么的".to_owned(),
        "帮我总结一下这个目录".to_owned(),
        "explain this command and its output ".repeat(24),
    ];
    for model in [&original, &prepared] {
        for input in &inputs {
            black_box(model.run_inference(input).unwrap());
        }
    }
    let mut baseline = Vec::new();
    let mut cached = Vec::new();
    for round in 0..80 {
        let input = &inputs[round % inputs.len()];
        // Alternate execution order to avoid systematically favoring either model.
        let order = if round % 2 == 0 { [0, 1] } else { [1, 0] };
        for index in order {
            let model = [&original, &prepared][index];
            let started = Instant::now();
            black_box(model.run_inference(black_box(input)).unwrap());
            [&mut baseline, &mut cached][index].push(started.elapsed());
        }
    }
    eprintln!("initialization: {initialization:?}");
    for (name, mut samples) in [("upstream", baseline), ("cached", cached)] {
        let median = percentile(&mut samples, 50);
        let p95 = percentile(&mut samples, 95);
        eprintln!("{name}: n={}, p50={median:?}, p95={p95:?}", samples.len());
    }
}

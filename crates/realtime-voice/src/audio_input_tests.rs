use super::*;

async fn receive(chunks: Vec<Vec<i16>>, rate: SampleRate) -> Vec<i16> {
    let (sender, receiver) = mpsc::channel(8);
    for chunk in chunks {
        sender.send(chunk).await.unwrap();
    }
    drop(sender);
    let mut input = AudioInput::open(
        Path::new("must-not-open-a-device"),
        None,
        rate,
        Some(receiver),
    )
    .await
    .unwrap();
    let mut samples = Vec::new();
    while let Some(chunk) = input.next_capture().await.unwrap() {
        samples.extend(chunk);
    }
    input.close().await.unwrap();
    samples
}

#[tokio::test]
async fn external_input_preserves_packet_order_and_never_opens_the_device_helper() {
    assert_eq!(
        receive(vec![vec![1, 2], vec![3, -4]], SampleRate::Hz16000).await,
        [1, 2, 3, -4]
    );
}

#[tokio::test]
async fn provider_rate_conversion_preserves_phase_and_flushes_the_tail() {
    let combined = receive(vec![vec![0, 1000, 2000, 3000]], SampleRate::Hz24000).await;
    let split = receive(
        vec![vec![0], vec![1000, 2000], vec![3000]],
        SampleRate::Hz24000,
    )
    .await;
    assert_eq!(combined, [0, 666, 1333, 2000, 2666, 3000]);
    assert_eq!(split, combined);
}

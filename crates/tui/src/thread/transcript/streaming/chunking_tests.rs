use super::*;

#[test]
fn normal_pressure_releases_one_line_and_depth_or_age_enters_catch_up() {
    let now = Instant::now();
    let mut policy = ChunkingPolicy::default();
    assert_eq!(policy.drain_count(3, Duration::ZERO, now), 1);
    assert_eq!(policy.drain_count(8, Duration::ZERO, now), 8);
    let mut policy = ChunkingPolicy::default();
    assert_eq!(policy.drain_count(3, Duration::from_millis(120), now), 3);
}

#[test]
fn low_pressure_must_hold_and_severe_backlog_bypasses_reentry_cooldown() {
    let now = Instant::now();
    let mut policy = ChunkingPolicy::default();
    assert_eq!(policy.drain_count(8, Duration::ZERO, now), 8);
    assert_eq!(policy.drain_count(2, Duration::ZERO, now), 2);
    assert_eq!(
        policy.drain_count(2, Duration::ZERO, now + Duration::from_millis(249)),
        2
    );
    assert_eq!(
        policy.drain_count(2, Duration::ZERO, now + Duration::from_millis(250)),
        1
    );
    assert_eq!(
        policy.drain_count(8, Duration::ZERO, now + Duration::from_millis(251)),
        1
    );
    assert_eq!(
        policy.drain_count(64, Duration::ZERO, now + Duration::from_millis(252)),
        64
    );
    assert_eq!(
        policy.drain_count(0, Duration::ZERO, now + Duration::from_millis(253)),
        0
    );
    assert_eq!(
        policy.drain_count(
            3,
            Duration::from_millis(300),
            now + Duration::from_millis(254)
        ),
        3
    );
}

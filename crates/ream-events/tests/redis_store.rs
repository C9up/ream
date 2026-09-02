//! The Redis event store against a REAL Redis, gated on `REAM_TEST_REDIS_URL`.
//!
//! It had no test of any kind. That was survivable while the `redis` crate sat
//! on one major, and stopped being so at the 0.32 → 1.0 bump: the store
//! compiled unchanged, which says nothing about whether a Lua script still
//! returns what the code reads out of it, or whether a pipeline still applies
//! in order. "It builds" is not evidence for a durable store.
//!
//!     podman run -d -p 6380:6379 redis:7-alpine
//!     REAM_TEST_REDIS_URL=redis://127.0.0.1:6380 cargo test -p ream-events --all-features

#![cfg(feature = "redis-store")]

use ream_events::{Event, EventStatus, EventStore, RedisStore};

/// A store on a database of its own, or `None` when no Redis is configured.
fn store() -> Option<RedisStore> {
    let url = std::env::var("REAM_TEST_REDIS_URL").ok()?;
    Some(RedisStore::new(&url).expect("connects to the configured Redis"))
}

#[test]
fn an_event_survives_a_round_trip() {
    let Some(store) = store() else { return };
    let event = Event::new("order.created", r#"{"id":1}"#);
    let id = event.id.clone();

    store.push(event, 3).expect("pushes");

    let found = store.get(&id).expect("the event comes back");
    assert_eq!(found.event.name, "order.created");
    assert_eq!(found.event.data, r#"{"id":1}"#);
    assert!(matches!(found.status, EventStatus::Pending));
}

#[test]
fn acknowledging_moves_an_event_out_of_pending() {
    let Some(store) = store() else { return };
    let event = Event::new("order.shipped", "{}");
    let id = event.id.clone();
    store.push(event, 3).expect("pushes");

    assert!(
        store.get_pending().iter().any(|e| e.event.id == id),
        "a pushed event starts pending"
    );

    store.ack(&id, EventStatus::Success).expect("acks");

    assert!(
        !store.get_pending().iter().any(|e| e.event.id == id),
        "an acked event is no longer pending"
    );
    let found = store.get(&id).expect("still readable");
    assert!(matches!(found.status, EventStatus::Success));
}

#[test]
fn a_failure_lands_in_the_dead_letter_queue() {
    let Some(store) = store() else { return };
    let event = Event::new("payment.declined", "{}");
    let id = event.id.clone();
    store.push(event, 3).expect("pushes");

    store
        .ack(
            &id,
            EventStatus::Failed {
                error: "gateway refused".into(),
                severity: "high".into(),
            },
        )
        .expect("acks the failure");

    let failed = store.get_failed();
    let entry = failed
        .iter()
        .find(|e| e.event.id == id)
        .expect("the failure is in the dead letter queue");
    match &entry.status {
        EventStatus::Failed { error, severity } => {
            assert_eq!(error, "gateway refused");
            assert_eq!(severity, "high");
        }
        other => panic!("expected a failure status, got {other:?}"),
    }
}

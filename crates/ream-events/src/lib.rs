//! # ream-bus
//!
//! event bus core for the Ream framework.
//!
//! Provides a high-performance, instanciable event bus with:
//! - Emit/subscribe with exact and wildcard pattern matching
//! - Event correlation/causation ID chain tracing
//! - Distribution-ready event envelope
//!
//! @implements FR1, FR2, FR3, FR5, FR6, FR9, FR10

pub mod bus;
pub mod event;
pub mod retry;
pub mod router;
pub mod store;
#[cfg(feature = "redis-store")]
pub mod redis_store;

pub use bus::{Bus, RequestHandler};
pub use event::Event;
pub use retry::{FallibleHandler, RetryConfig};
pub use router::{EventHandler, EventRouter, SubscriptionId, wildcard_matches};
pub use store::{EventStatus, EventStore, MemoryStore, TrackedEvent};
#[cfg(feature = "redis-store")]
pub use redis_store::RedisStore;

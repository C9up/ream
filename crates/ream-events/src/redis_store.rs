//! Redis/KeyDB EventStore implementation.
//!
//! Provides persistent event storage for production use.
//! Compatible with Redis and KeyDB (same protocol).

#[cfg(feature = "redis-store")]
mod inner {
    use crate::event::Event;
    use crate::store::{EventStatus, EventStore, TrackedEvent};
    use redis::{Client, Commands, Connection};
    use std::sync::Mutex;

    const KEY_PREFIX: &str = "ream:events:";
    const PENDING_SET: &str = "ream:events:pending";
    const FAILED_SET: &str = "ream:events:failed";

    /// Redis-backed event store for production deployments.
    /// Compatible with Redis and KeyDB.
    pub struct RedisStore {
        conn: Mutex<Connection>,
    }

    impl RedisStore {
        /// Connect to Redis/KeyDB.
        /// url format: "redis://127.0.0.1:6379" or "redis://:password@host:port/db"
        pub fn new(url: &str) -> Result<Self, String> {
            let client = Client::open(url).map_err(|e| format!("Redis connection failed: {}", e))?;
            let conn = client
                .get_connection()
                .map_err(|e| format!("Redis connection failed: {}", e))?;
            Ok(Self {
                conn: Mutex::new(conn),
            })
        }
    }

    impl EventStore for RedisStore {
        fn push(&self, event: Event, max_retries: u8) -> Result<(), String> {
            let tracked = TrackedEvent {
                event: event.clone(),
                status: EventStatus::Pending,
                retry_count: 0,
                max_retries,
                last_error: None,
            };
            let json =
                serde_json::to_string(&tracked).map_err(|e| format!("Serialization error: {}", e))?;
            let key = format!("{}{}", KEY_PREFIX, event.id);

            let mut conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
            let _: () = conn
                .set(&key, &json)
                .map_err(|e| format!("Redis SET error: {}", e))?;
            let _: () = conn
                .sadd(PENDING_SET, &event.id)
                .map_err(|e| format!("Redis SADD error: {}", e))?;
            Ok(())
        }

        fn ack(&self, event_id: &str, status: EventStatus) -> Result<(), String> {
            let key = format!("{}{}", KEY_PREFIX, event_id);

            let is_failed = matches!(status, EventStatus::Failed { .. });
            let status_json =
                serde_json::to_string(&status).map_err(|e| format!("Serialization error: {}", e))?;
            let retry_count = if let EventStatus::Retrying { attempt } = &status {
                *attempt
            } else {
                0
            };
            let last_error = if let EventStatus::Failed { ref error, .. } = status {
                error.clone()
            } else {
                String::new()
            };

            let lua_script = redis::Script::new(r#"
                local key = KEYS[1]
                local pending_set = ARGV[1]
                local failed_set = ARGV[2]
                local is_failed = ARGV[3]
                local event_id = ARGV[4]
                local status_json = ARGV[5]
                local retry_count = tonumber(ARGV[6])
                local last_error = ARGV[7]

                local raw = redis.call('GET', key)
                if not raw then
                    return redis.error_reply('EVENT_NOT_FOUND')
                end
                local tracked = cjson.decode(raw)
                tracked['status'] = cjson.decode(status_json)
                if retry_count > 0 then
                    tracked['retryCount'] = retry_count
                end
                if last_error ~= '' then
                    tracked['lastError'] = last_error
                end
                redis.call('SET', key, cjson.encode(tracked))
                redis.call('SREM', pending_set, event_id)
                if is_failed == '1' then
                    redis.call('SADD', failed_set, event_id)
                end
                return 1
            "#);

            let mut conn = self.conn.lock().map_err(|e| format!("Lock error: {}", e))?;
            lua_script
                .key(&key)
                .arg(PENDING_SET)
                .arg(FAILED_SET)
                .arg(if is_failed { "1" } else { "0" })
                .arg(event_id)
                .arg(&status_json)
                .arg(retry_count as u64)
                .arg(&last_error)
                .invoke::<redis::Value>(&mut *conn)
                .map_err(|e| format!("Redis Lua error: {}", e))?;

            Ok(())
        }

        fn get_pending(&self) -> Vec<TrackedEvent> {
            self.get_set_members(PENDING_SET)
        }

        fn get_failed(&self) -> Vec<TrackedEvent> {
            self.get_set_members(FAILED_SET)
        }

        fn get(&self, event_id: &str) -> Option<TrackedEvent> {
            let key = format!("{}{}", KEY_PREFIX, event_id);
            let mut conn = self.conn.lock().ok()?;
            let json: Option<String> = conn.get(&key).ok()?;
            json.and_then(|j| serde_json::from_str(&j).ok())
        }

        fn count(&self) -> usize {
            let mut conn = match self.conn.lock() {
                Ok(c) => c,
                Err(_) => return 0,
            };
            let pending: usize = conn.scard(PENDING_SET).unwrap_or(0);
            let failed: usize = conn.scard(FAILED_SET).unwrap_or(0);
            pending + failed
        }
    }

    impl RedisStore {
        fn get_set_members(&self, set_key: &str) -> Vec<TrackedEvent> {
            let mut conn = match self.conn.lock() {
                Ok(c) => c,
                Err(_) => return vec![],
            };
            let ids: Vec<String> = conn.smembers(set_key).unwrap_or_default();
            if ids.is_empty() {
                return vec![];
            }
            let keys: Vec<String> = ids.iter().map(|id| format!("{}{}", KEY_PREFIX, id)).collect();
            let mut pipe = redis::pipe();
            for key in &keys {
                pipe.get(key);
            }
            let results: Vec<Option<String>> = pipe.query(&mut *conn).unwrap_or_default();
            results
                .into_iter()
                .filter_map(|maybe_json| {
                    let json = maybe_json?;
                    serde_json::from_str(&json).ok()
                })
                .collect()
        }
    }
}

#[cfg(feature = "redis-store")]
pub use inner::RedisStore;

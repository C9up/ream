//! # ream-http-napi
//!
//! NAPI bindings for the Ream Hyper HTTP server and security primitives.
//!
//! @implements FR23, FR52

use napi::bindgen_prelude::{Function, Promise, Unknown};
use napi::threadsafe_function::{ThreadsafeCallContext, ThreadsafeFunctionCallMode};
use napi::JsValue;
use napi_derive::napi;
use ream_http::{
    RateLimitConfig, RateLimiter, ReamRequest, ReamResponse, ReamServer, ShieldConfig,
    ShieldFilter, StreamRegistry,
};
use ream_napi_core::callback::FatalThreadsafeFunction;
use ream_napi_core::catch_unwind_napi;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex as TokioMutex;

/// Typed response object crossing the TS→NAPI→Rust boundary.
///
/// Using `#[napi(object)]` (instead of `String` carrying JSON) means napi-rs
/// walks the JS object tree directly into Rust fields — zero JSON parse overhead.
///
/// When `stream_id` is set, `body` is ignored and the hyper response is fed
/// from the matching entry in the shared `StreamRegistry`. The handler must
/// have called [`HyperServer::register_stream`] with that id BEFORE
/// returning, otherwise the response collapses to a 500 (E_STREAM_UNKNOWN).
#[napi(object)]
pub struct NapiResponse {
    pub status: u32,
    pub headers: HashMap<String, String>,
    pub body: String,
    pub stream_id: Option<String>,
}

impl From<NapiResponse> for ReamResponse {
    fn from(r: NapiResponse) -> Self {
        ReamResponse {
            status: r.status as u16,
            headers: r.headers,
            body: r.body,
            stream_id: r.stream_id,
        }
    }
}

/// Configuration for the wire-level shield filter. Mirrors the Rust
/// `ShieldConfig` shape; the JS layer constructs it from `ShieldMiddleware`
/// options at boot and hands it off to `HyperServer.configureShield`.
#[napi(object)]
pub struct NapiShieldConfig {
    pub path_traversal: bool,
    pub param_pollution: bool,
}

/// Configuration for the wire-level rate limiter. `windowSecs` is the size
/// of the fixed window in seconds; `max` is the request budget per key
/// (resolved client IP) per window.
#[napi(object)]
pub struct NapiRateLimitConfig {
    pub max: u32,
    pub window_secs: u32,
}

/// NAPI-exposed Hyper HTTP server.
#[napi]
pub struct HyperServer {
    port: u16,
    host: [u8; 4],
    handler: Arc<std::sync::Mutex<Option<ream_http::RequestHandler>>>,
    server: Arc<TokioMutex<Option<ream_http::ReamServer>>>,
    shield: Arc<std::sync::Mutex<Option<ShieldConfig>>>,
    trusted_proxies: Arc<std::sync::Mutex<Vec<String>>>,
    rate_limiter: Arc<std::sync::Mutex<Option<Arc<RateLimiter>>>>,
    /// Streaming bodies registry. Owned by `HyperServer` so JS can call
    /// `registerStream` / `writeStream` BEFORE `listen()` has wired the
    /// inner `ReamServer` (which clones the same handle on boot). Avoids
    /// "server not started" surprises for ahead-of-time stream setup.
    stream_registry: StreamRegistry,
}

#[napi]
impl HyperServer {
    /// `host` is the bind address: an IPv4 literal (`0.0.0.0` to accept from
    /// every interface) or the `localhost` alias. Omitted → loopback only,
    /// the safe default for a dev machine.
    #[napi(constructor)]
    pub fn new(port: Option<u32>, host: Option<String>) -> napi::Result<Self> {
        catch_unwind_napi(|| {
            let port_val = port.unwrap_or(0);
            if port_val > 65535 {
                return Err(ream_napi_core::ream_error!(
                    "INVALID_PORT",
                    format!("Port {} exceeds maximum 65535", port_val)
                )
                .into());
            }
            let port = port_val as u16;
            let host = match host.as_deref() {
                None | Some("localhost") => [127, 0, 0, 1],
                Some(h) => match h.parse::<std::net::Ipv4Addr>() {
                    Ok(addr) => addr.octets(),
                    Err(_) => {
                        return Err(ream_napi_core::ream_error!(
                            "INVALID_HOST",
                            format!(
                                "Invalid host '{}' — expected an IPv4 address or 'localhost'",
                                h
                            )
                        )
                        .into());
                    }
                },
            };
            Ok(Self {
                port,
                host,
                handler: Arc::new(std::sync::Mutex::new(None)),
                server: Arc::new(TokioMutex::new(None)),
                shield: Arc::new(std::sync::Mutex::new(None)),
                trusted_proxies: Arc::new(std::sync::Mutex::new(Vec::new())),
                rate_limiter: Arc::new(std::sync::Mutex::new(None)),
                stream_registry: StreamRegistry::new(),
            })
        })
    }

    /// Register the request handler. Callback receives JSON request string, must return JSON response string.
    ///
    #[napi]
    pub fn on_request(
        &self,
        // The promise the handler returns is part of the FUNCTION's type in
        // napi 3, where napi 2 named it at the `call_async` call site.
        callback: Function<'static, Unknown<'static>, Promise<NapiResponse>>,
    ) -> napi::Result<()> {
        // Pass request as serde_json::Value → JsObject (no string serialization).
        // Response comes back as JSON string (TS side still stringifies for now).
        // `CalleeHandled = false`, like every other threadsafe function here:
        // napi 3 implements `call_async` for BOTH modes — the `false` variant
        // takes the value directly where the `true` one takes a `Result` — so
        // awaiting the handler's promise costs nothing here. Taking `true`
        // would have prepended a `null` and changed `onRequest(request => …)`
        // into `(err, request) => …` for every caller.
        //
        // The argument type is the RAW `napi_value`: a `Unknown<'a>` produced
        // from the callback's own `Env` cannot satisfy the `'static` bound the
        // argument type carries. It is a pointer, and napi converts it back
        // before the scope ends.
        let tsfn: FatalThreadsafeFunction<
            serde_json::Value,
            napi::sys::napi_value,
            Promise<NapiResponse>,
        > = callback
            .build_threadsafe_function::<serde_json::Value>()
            .callee_handled::<false>()
            .build_callback(|ctx: ThreadsafeCallContext<serde_json::Value>| {
                // Convert serde Value directly to JsObject (no JSON string intermediate)
                Ok(ctx.env.to_js_value(&ctx.value)?.value().value)
            })?;

        let tsfn = Arc::new(tsfn);

        let handler: ream_http::RequestHandler = Arc::new(move |req: ReamRequest| {
            let tsfn = tsfn.clone();
            Box::pin(async move {
                // Inbound: struct → serde Value (no JSON string).
                // The threadsafe-function callback uses to_js_value to walk the
                // Value into a JsObject directly — no JSON.parse on the JS side.
                let req_value = serde_json::to_value(&req).unwrap_or_default();

                // Outbound: typed NapiResponse — napi-rs walks the JS object tree
                // straight into the Rust struct, no JSON.stringify on JS side
                // and no serde_json::from_str on Rust side. Zero JSON ops per request.
                // The return type is on the ThreadsafeFunction now, where
                // napi 2 named it at this call site.
                match tsfn.call_async(req_value).await {
                    Ok(promise) => match promise.await {
                        Ok(napi_res) => napi_res.into(),
                        Err(_) => ReamResponse::text(500, "Handler rejected"),
                    },
                    Err(_) => ReamResponse::text(500, "Failed to call handler"),
                }
            })
        });

        // Store handler directly — std::sync::Mutex, no async needed
        let mut guard = self.handler.lock().map_err(|_| {
            napi::Error::new(napi::Status::GenericFailure, "Handler mutex poisoned")
        })?;
        *guard = Some(handler);

        Ok(())
    }

    /// Configure the trusted-proxy CIDR list used by `request.ip` resolution.
    /// Must be called BEFORE `listen()`. Empty list = legacy permissive mode
    /// (any peer can populate `X-Forwarded-For`).
    #[napi]
    pub fn configure_trusted_proxies(&self, cidrs: Vec<String>) -> napi::Result<()> {
        let mut guard = self.trusted_proxies.lock().map_err(|_| {
            napi::Error::new(
                napi::Status::GenericFailure,
                "Trusted-proxies mutex poisoned",
            )
        })?;
        *guard = cidrs;
        Ok(())
    }

    /// Install (or replace) the wire-level rate limiter. Pass `None` to
    /// disable. Must be called BEFORE `listen()`.
    #[napi]
    pub fn configure_rate_limit(&self, config: Option<NapiRateLimitConfig>) -> napi::Result<()> {
        let mut guard = self.rate_limiter.lock().map_err(|_| {
            napi::Error::new(napi::Status::GenericFailure, "Rate-limiter mutex poisoned")
        })?;
        *guard = config.map(|c| {
            Arc::new(RateLimiter::new(RateLimitConfig {
                max: c.max,
                window: Duration::from_secs(c.window_secs as u64),
            }))
        });
        Ok(())
    }

    /// Configure the wire-level security shield. Must be called BEFORE
    /// `listen()` — the configuration is captured into the security filter
    /// when the server starts. Calling after `listen()` has no effect.
    #[napi]
    pub fn configure_shield(&self, config: NapiShieldConfig) -> napi::Result<()> {
        let mut guard = self
            .shield
            .lock()
            .map_err(|_| napi::Error::new(napi::Status::GenericFailure, "Shield mutex poisoned"))?;
        *guard = Some(ShieldConfig {
            path_traversal: config.path_traversal,
            param_pollution: config.param_pollution,
        });
        Ok(())
    }

    /// Start the HTTP server.
    #[napi]
    pub async fn listen(&self) -> napi::Result<()> {
        let handler = {
            let guard = self.handler.lock().map_err(|_| {
                napi::Error::new(napi::Status::GenericFailure, "Handler mutex poisoned")
            })?;
            guard.clone().ok_or_else(|| {
                napi::Error::new(
                    napi::Status::GenericFailure,
                    "No handler registered. Call onRequest() before listen()",
                )
            })?
        };

        let port = self.port;
        let server_ref = self.server.clone();

        // Use shared Tokio runtime instead of creating a new one (PERF-3)
        let rt_ref = ream_napi_core::shared_runtime();

        // Create server, configure, and listen
        let mut srv = ReamServer::new(port).with_host(self.host);
        srv.on_request(handler);
        srv.set_stream_registry(self.stream_registry.clone());

        // Wire the shield filter if the JS side configured it before boot.
        // No call → no filter installed (server runs with `NoopFilter`).
        let shield = {
            let guard = self.shield.lock().map_err(|_| {
                napi::Error::new(napi::Status::GenericFailure, "Shield mutex poisoned")
            })?;
            *guard
        };
        if let Some(config) = shield {
            srv.set_security_filter(Arc::new(ShieldFilter::new(config)));
        }

        // Wire trusted-proxy CIDR list — drives `request.ip` resolution.
        let trusted = {
            let guard = self.trusted_proxies.lock().map_err(|_| {
                napi::Error::new(
                    napi::Status::GenericFailure,
                    "Trusted-proxies mutex poisoned",
                )
            })?;
            guard.clone()
        };
        srv.set_trusted_proxies(trusted);

        // Wire rate limiter — pre-NAPI throttle keyed by `request.ip`.
        let limiter = {
            let guard = self.rate_limiter.lock().map_err(|_| {
                napi::Error::new(napi::Status::GenericFailure, "Rate-limiter mutex poisoned")
            })?;
            guard.clone()
        };
        srv.set_rate_limiter(limiter);

        // Wire XSS response sanitization via the standalone blackhole-engine.
        // The adapter closure bridges between ream-http's ReamResponse type and
        // blackhole-engine's standalone (body, content_type) → String API.
        srv.set_response_filter(Arc::new(|mut response: ream_http::ReamResponse| {
            let ct = response
                .headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
                .map(|(_, v)| v.as_str())
                .unwrap_or("");
            response.body = blackhole_engine::sanitize_response(&response.body, ct);
            response
        }));

        // Use a oneshot channel to signal when the server is ready
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Option<String>>();
        let server_ref_clone = server_ref.clone();

        rt_ref.spawn(async move {
            match srv.listen().await {
                Ok(()) => {
                    // Store the server BEFORE signaling ready — prevents race where
                    // port()/close() is called between ready_tx.send and the store.
                    *server_ref_clone.lock().await = Some(srv);
                    let _ = ready_tx.send(None); // None = success
                }
                Err(e) => {
                    let _ = ready_tx.send(Some(format!("{}", e))); // Some = error
                }
            }
        });

        // Wait for the server to bind (no sleep — proper signal)
        match ready_rx.await {
            Ok(None) => {} // Success
            Ok(Some(e)) => {
                return Err(napi::Error::new(
                    napi::Status::GenericFailure,
                    format!("Server bind failed: {}", e),
                ))
            }
            Err(_) => {
                return Err(napi::Error::new(
                    napi::Status::GenericFailure,
                    "Server startup channel closed",
                ))
            }
        }

        // Shared runtime — no need to store (it's static)
        Ok(())
    }

    /// Get the actual bound port.
    #[napi]
    pub async fn port(&self) -> napi::Result<u32> {
        let srv = self.server.lock().await;
        match srv.as_ref() {
            Some(s) => Ok(s.actual_port().await as u32),
            None => Err(napi::Error::new(
                napi::Status::GenericFailure,
                "Server not started",
            )),
        }
    }

    /// Shut down the server and release the handles that keep the host's event
    /// loop alive.
    ///
    /// `listen()` registers the JS callback as a `ThreadsafeFunction` (which
    /// holds a libuv ref so `ream start` stays alive). Three `Arc` clones of the
    /// request handler capture it: this struct's `self.handler`, the inner
    /// `ReamServer.handler`, and the accept-loop task's clone. ALL three must
    /// drop for napi-rs to release the tsfn on `Drop` (refcount → 0). The old
    /// `close()` only signalled shutdown, leaving every clone alive — so an
    /// in-process host (test harness) leaked the handle and never drained.
    #[napi]
    pub async fn close(&self) -> napi::Result<()> {
        {
            let mut srv = self.server.lock().await;
            if let Some(mut s) = srv.take() {
                // Signal the accept loop AND await its end (drops its handler
                // clone); `s` then drops here, releasing ReamServer's clone.
                s.shutdown().await;
            }
        }
        // Drop the original handler held on this struct → the last Arc clone
        // goes, the captured ThreadsafeFunction's refcount hits zero, and
        // napi-rs releases its libuv handle on Drop.
        if let Ok(mut guard) = self.handler.lock() {
            *guard = None;
        }
        // Shared runtime is static — not dropped on close (reused by other crates)
        Ok(())
    }

    // ─── Streaming response API (SSE etc.) ─────────────────────
    //
    // The buffered request/response path (`onRequest` → return body) covers
    // the common case. SSE and chunked downloads need an open connection
    // that JS keeps feeding for minutes or hours. Those four methods stitch
    // that into the buffered path without breaking the existing contract:
    //
    //   1. The handler picks a fresh `stream_id` (UUID), calls
    //      `registerStream(id)` (synchronous from JS — awaited promise),
    //      and returns a `NapiResponse` carrying that id.
    //   2. Hyper sees the id and feeds the response body from the matching
    //      `StreamRegistry` entry instead of the buffered string.
    //   3. JS calls `writeStream(id, chunk)` repeatedly. Returns `false`
    //      once the client has disconnected — caller stops pushing.
    //   4. `onDisconnect(id, cb)` registers a one-shot callback fired the
    //      moment the receiver side of the mpsc is dropped (i.e. the
    //      client closed the connection or `closeStream` was called).
    //   5. `closeStream(id)` ends the response normally from the server
    //      side. Idempotent — safe to call twice or after a disconnect.

    /// Reserve a slot in the stream registry. Returns `false` if the id
    /// already exists (caller picked a colliding UUID). Always returns
    /// before `listen()` need have run.
    #[napi]
    pub async fn register_stream(&self, stream_id: String) -> napi::Result<bool> {
        Ok(self.stream_registry.register(stream_id).await)
    }

    /// Push a chunk onto a registered stream. Returns `false` when the
    /// stream has already finished (receiver dropped — client gone or
    /// `closeStream` called) so the caller can bail out of its push
    /// loop. Backpressure is handled silently: a full buffer drops the
    /// frame rather than awaiting — SSE is fire-and-forget by design.
    #[napi]
    pub async fn write_stream(&self, stream_id: String, chunk: String) -> napi::Result<bool> {
        Ok(self
            .stream_registry
            .send_chunk(&stream_id, chunk.into_bytes().into())
            .await)
    }

    /// Push a BINARY chunk onto a registered stream, waiting for room.
    ///
    /// The counterpart of [`write_stream`](Self::write_stream) for a body the
    /// client reassembles — a file, an export, an archive. Two differences,
    /// both required there and both wrong for SSE:
    ///
    /// * it takes bytes, not a `String`, so a payload that is not valid UTF-8
    ///   survives the crossing intact;
    /// * it AWAITS when the channel is full instead of dropping the frame, so
    ///   a slow client slows the producer rather than silently receiving a
    ///   truncated file.
    ///
    /// Returns `false` when the receiver is gone (client disconnected or the
    /// stream was closed), so the caller can stop reading its source.
    #[napi]
    pub async fn write_stream_bytes(
        &self,
        stream_id: String,
        chunk: napi::bindgen_prelude::Uint8Array,
    ) -> napi::Result<bool> {
        // Copied once out of the JS-owned buffer: the caller may reuse or free
        // it the moment this returns, and the frame outlives the call.
        Ok(self
            .stream_registry
            .send_chunk_awaiting(&stream_id, chunk.to_vec())
            .await)
    }

    /// Close a stream from the server side. The matching response body
    /// finishes cleanly (hyper writes the final chunk + `0\r\n\r\n` for
    /// HTTP/1.1 chunked encoding). Idempotent.
    #[napi]
    pub async fn close_stream(&self, stream_id: String) -> napi::Result<bool> {
        Ok(self.stream_registry.close(&stream_id).await)
    }

    /// Install a one-shot callback fired the moment the matching stream
    /// receiver is dropped — i.e. the client disconnected or
    /// `closeStream` was called. Used by the JS SDK to drop subscription
    /// bookkeeping when an SSE viewer leaves.
    ///
    /// The callback runs on the libuv loop via the threadsafe-function
    /// machinery, so JS code in the callback uses regular await /
    /// reentrant container calls without crossing-thread surprises.
    #[napi]
    pub fn on_stream_disconnect(
        &self,
        stream_id: String,
        callback: Function<'static, Unknown<'static>, Unknown<'static>>,
    ) -> napi::Result<()> {
        // No payload: napi 3 maps the unit type to `undefined`, so the
        // hand-built `get_undefined()` this needed is gone.
        let tsfn: FatalThreadsafeFunction<(), ()> = callback
            .build_threadsafe_function::<()>()
            .callee_handled::<false>()
            .build_callback(|_ctx: ThreadsafeCallContext<()>| Ok(()))?;
        let registry = self.stream_registry.clone();
        let rt = ream_napi_core::shared_runtime();
        rt.spawn(async move {
            registry.wait_for_disconnect(&stream_id).await;
            tsfn.call((), ThreadsafeFunctionCallMode::NonBlocking);
        });
        Ok(())
    }
}

// ─── Security bindings ──────────────────────────────────────

/// Sign a JWT payload with HMAC-SHA256 (Rust-native).
/// Returns the complete JWT token string.
#[napi]
pub fn jwt_sign(payload: String, secret: String) -> napi::Result<String> {
    catch_unwind_napi(|| {
        warden_engine::jwt_sign(&payload, secret.as_bytes())
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
    })
}

/// Verify a JWT token and return the decoded payload JSON string.
/// Validates signature (constant-time), exp, and nbf claims.
#[napi]
pub fn jwt_verify(token: String, secret: String) -> napi::Result<String> {
    catch_unwind_napi(|| {
        warden_engine::jwt_verify(&token, secret.as_bytes())
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
    })
}

// Argon2id + bcrypt routed through `sigil-engine`, the canonical password
// hashing crate since Story 40.1. Story 52.1 (2026-05-08) dropped the
// redundant copies from `warden-engine`; this NAPI surface migrated to
// `sigil-engine` to follow.

/// Hash a password with Argon2id (Rust-native).
/// Returns the PHC-formatted hash string.
#[napi]
pub fn argon2_hash(password: String) -> napi::Result<String> {
    catch_unwind_napi(|| {
        sigil_engine::argon2_hash(
            &password,
            sigil_engine::Argon2Options {
                memory_kib: None,
                iterations: None,
                parallelism: None,
            },
        )
        .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
    })
}

/// Verify a password against an Argon2id hash.
#[napi]
pub fn argon2_verify(password: String, hash: String) -> napi::Result<bool> {
    catch_unwind_napi(|| Ok(sigil_engine::argon2_verify(&password, &hash)))
}

/// Hash a password with bcrypt (Rust-native).
/// `rounds` defaults to 12 when not supplied — matches the previous
/// warden-engine default and the OWASP-recommended cost floor enforced
/// by `sigil-engine`.
#[napi]
pub fn bcrypt_hash(password: String, rounds: Option<u32>) -> napi::Result<String> {
    catch_unwind_napi(|| {
        sigil_engine::bcrypt_hash(&password, rounds.unwrap_or(12))
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
    })
}

/// Verify a password against a bcrypt hash.
#[napi]
pub fn bcrypt_verify(password: String, hash: String) -> napi::Result<bool> {
    catch_unwind_napi(|| {
        sigil_engine::bcrypt_verify(&password, &hash)
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
    })
}

/// Constant-time string comparison.
#[napi]
pub fn constant_time_eq(a: String, b: String) -> napi::Result<bool> {
    catch_unwind_napi(|| Ok(warden_engine::constant_time_eq(a.as_bytes(), b.as_bytes())))
}

/// HMAC-SHA256 sign. Returns base64url signature.
#[napi]
pub fn hmac_sign(data: String, secret: String) -> napi::Result<String> {
    catch_unwind_napi(|| {
        warden_engine::crypto::hmac_sign(&data, secret.as_bytes())
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
    })
}

/// HMAC-SHA256 verify (constant-time).
#[napi]
pub fn hmac_verify(data: String, signature: String, secret: String) -> napi::Result<bool> {
    catch_unwind_napi(|| {
        warden_engine::crypto::hmac_verify(&data, &signature, secret.as_bytes())
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
    })
}

/// Generate cryptographically secure random bytes as base64url.
#[napi]
pub fn random_bytes_base64(len: u32) -> napi::Result<String> {
    catch_unwind_napi(|| {
        warden_engine::crypto::random_bytes(len as usize)
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
    })
}

/// Generate cryptographically secure random bytes as hex.
#[napi]
pub fn random_hex(len: u32) -> napi::Result<String> {
    catch_unwind_napi(|| {
        warden_engine::crypto::random_hex(len as usize)
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
    })
}

// ─── GraphQL bindings ──────────────────────────────────────

/// Parse a GraphQL query using the Rust graphql-parser crate.
/// Returns JSON: { operationType, operationName, fields: [...], errors: [...] }
/// Invalid queries are rejected here — they never reach the TypeScript resolver layer.
#[napi]
pub fn graphql_parse(query: String) -> napi::Result<String> {
    catch_unwind_napi(|| {
        let result = ream_graphql::parse_graphql_query(&query);
        serde_json::to_string(&result)
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("{}", e)))
    })
}

/// Validate a GraphQL query string. Returns JSON array of error strings (empty = valid).
#[napi]
pub fn graphql_validate(query: String) -> napi::Result<String> {
    catch_unwind_napi(|| {
        let errors = ream_graphql::validate_query(&query);
        serde_json::to_string(&errors)
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("{}", e)))
    })
}

/// Extract argument scalar types from a GraphQL SDL schema.
/// Returns JSON: `{ "Type.field": { "argName": "ScalarType" } }` for argument
/// coercion in the TypeScript engine.
#[napi]
pub fn graphql_schema_arg_types(sdl: String) -> napi::Result<String> {
    catch_unwind_napi(|| {
        let types = ream_graphql::parse_schema_arg_types(&sdl);
        serde_json::to_string(&types)
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("{}", e)))
    })
}

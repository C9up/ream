//! # ream-http-napi
//!
//! NAPI bindings for the Ream Hyper HTTP server and security primitives.
//!
//! @implements FR23, FR52

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction};
use napi_derive::napi;
use ream_http::{ReamRequest, ReamResponse, ReamServer};
use ream_napi_core::catch_unwind_napi;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

/// NAPI-exposed Hyper HTTP server.
#[napi]
pub struct HyperServer {
    port: u16,
    handler: Arc<std::sync::Mutex<Option<ream_http::RequestHandler>>>,
    runtime: Arc<TokioMutex<Option<tokio::runtime::Runtime>>>,
    server: Arc<TokioMutex<Option<ream_http::ReamServer>>>,
}

#[napi]
impl HyperServer {
    #[napi(constructor)]
    pub fn new(port: Option<u32>) -> napi::Result<Self> {
        catch_unwind_napi(|| {
            let port_val = port.unwrap_or(0);
            if port_val > 65535 {
                return Err(ream_napi_core::ream_error!(
                    "INVALID_PORT",
                    format!("Port {} exceeds maximum 65535", port_val)
                ).into());
            }
            let port = port_val as u16;
            Ok(Self {
                port,
                handler: Arc::new(std::sync::Mutex::new(None)),
                runtime: Arc::new(TokioMutex::new(None)),
                server: Arc::new(TokioMutex::new(None)),
            })
        })
    }

    /// Register the request handler. Callback receives JSON request string, must return JSON response string.
    #[napi]
    pub fn on_request(&self, callback: JsFunction) -> napi::Result<()> {
        // Note: catch_unwind_napi not used here because the closure captures
        // Arc<Mutex<>> which is not UnwindSafe. This function cannot panic.
        let tsfn: ThreadsafeFunction<String, ErrorStrategy::Fatal> =
            callback.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<String>| {
                Ok(vec![ctx.env.create_string_from_std(ctx.value)?.into_unknown()])
            })?;

        let tsfn = Arc::new(tsfn);

        let handler: ream_http::RequestHandler = Arc::new(move |req: ReamRequest| {
            let tsfn = tsfn.clone();
            Box::pin(async move {
                let req_json = serde_json::to_string(&req).unwrap_or_default();

                match tsfn.call_async::<Promise<String>>(req_json).await {
                    Ok(promise) => match promise.await {
                        Ok(response_json) => {
                            serde_json::from_str::<ReamResponse>(&response_json)
                                .unwrap_or_else(|_| ReamResponse::text(500, "Invalid response"))
                        }
                        Err(_) => ReamResponse::text(500, "Handler rejected"),
                    },
                    Err(_) => ReamResponse::text(500, "Failed to call handler"),
                }
            })
        });

        // Store handler directly — std::sync::Mutex, no async needed
        let mut guard = self.handler.lock()
            .map_err(|_| napi::Error::new(napi::Status::GenericFailure, "Handler mutex poisoned"))?;
        *guard = Some(handler);

        Ok(())
    }

    /// Start the HTTP server.
    #[napi]
    pub async fn listen(&self) -> napi::Result<()> {
        let handler = {
            let guard = self.handler.lock()
                .map_err(|_| napi::Error::new(napi::Status::GenericFailure, "Handler mutex poisoned"))?;
            guard.clone().ok_or_else(|| napi::Error::new(napi::Status::GenericFailure, "No handler registered. Call onRequest() before listen()"))?
        };

        let port = self.port;
        let server_ref = self.server.clone();
        let runtime_ref = self.runtime.clone();

        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, format!("{}", e)))?;

        // Create server and set ref before spawning listen
        let mut srv = ReamServer::new(port);
        srv.on_request(handler);

        let server_ref_clone = server_ref.clone();
        rt.spawn(async move {
            if let Err(e) = srv.listen().await {
                eprintln!("Server error: {}", e);
            }
            *server_ref_clone.lock().await = Some(srv);
        });

        // Give server time to bind
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        *runtime_ref.lock().await = Some(rt);
        Ok(())
    }

    /// Get the actual bound port.
    #[napi]
    pub async fn port(&self) -> napi::Result<u32> {
        let srv = self.server.lock().await;
        match srv.as_ref() {
            Some(s) => Ok(s.actual_port().await as u32),
            None => Err(napi::Error::new(napi::Status::GenericFailure, "Server not started")),
        }
    }

    /// Shut down the server.
    #[napi]
    pub async fn close(&self) -> napi::Result<()> {
        {
            let mut srv = self.server.lock().await;
            if let Some(ref mut s) = *srv {
                s.close();
            }
        }
        let mut rt_lock = self.runtime.lock().await;
        if let Some(rt) = rt_lock.take() {
            std::thread::spawn(move || drop(rt))
                .join()
                .map_err(|_| napi::Error::new(napi::Status::GenericFailure, "Shutdown failed"))?;
        }
        Ok(())
    }
}

// ─── Security bindings ──────────────────────────────────────

/// Sign a JWT payload with HMAC-SHA256 (Rust-native).
/// Returns the complete JWT token string.
#[napi]
pub fn jwt_sign(payload: String, secret: String) -> napi::Result<String> {
    catch_unwind_napi(|| {
        ream_security::jwt::sign(&payload, secret.as_bytes())
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
    })
}

/// Verify a JWT token and return the decoded payload JSON string.
/// Validates signature (constant-time), exp, and nbf claims.
#[napi]
pub fn jwt_verify(token: String, secret: String) -> napi::Result<String> {
    catch_unwind_napi(|| {
        ream_security::jwt::verify(&token, secret.as_bytes())
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
    })
}

/// Hash a password with Argon2id (Rust-native).
/// Returns the PHC-formatted hash string.
#[napi]
pub fn argon2_hash(password: String) -> napi::Result<String> {
    catch_unwind_napi(|| {
        ream_security::argon2_hash::hash_password(&password)
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
    })
}

/// Verify a password against an Argon2id hash.
#[napi]
pub fn argon2_verify(password: String, hash: String) -> napi::Result<bool> {
    catch_unwind_napi(|| {
        ream_security::argon2_hash::verify_password(&password, &hash)
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
    })
}

/// Hash a password with bcrypt (Rust-native).
#[napi]
pub fn bcrypt_hash(password: String, rounds: Option<u32>) -> napi::Result<String> {
    catch_unwind_napi(|| {
        ream_security::bcrypt_hash::hash_password(&password, rounds)
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
    })
}

/// Verify a password against a bcrypt hash.
#[napi]
pub fn bcrypt_verify(password: String, hash: String) -> napi::Result<bool> {
    catch_unwind_napi(|| {
        ream_security::bcrypt_hash::verify_password(&password, &hash)
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
    })
}

/// Generate a CSRF token.
#[napi]
pub fn csrf_generate() -> napi::Result<String> {
    catch_unwind_napi(|| {
        let mut csrf = ream_security::csrf::CsrfValidator::new();
        Ok(csrf.generate_token())
    })
}

/// Constant-time string comparison.
#[napi]
pub fn constant_time_eq(a: String, b: String) -> napi::Result<bool> {
    catch_unwind_napi(|| {
        Ok(ream_security::constant_time::constant_time_eq(a.as_bytes(), b.as_bytes()))
    })
}

/// HMAC-SHA256 sign. Returns base64url signature.
#[napi]
pub fn hmac_sign(data: String, secret: String) -> napi::Result<String> {
    catch_unwind_napi(|| {
        ream_security::crypto::hmac_sign(&data, secret.as_bytes())
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
    })
}

/// HMAC-SHA256 verify (constant-time).
#[napi]
pub fn hmac_verify(data: String, signature: String, secret: String) -> napi::Result<bool> {
    catch_unwind_napi(|| {
        ream_security::crypto::hmac_verify(&data, &signature, secret.as_bytes())
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
    })
}

/// Generate cryptographically secure random bytes as base64url.
#[napi]
pub fn random_bytes_base64(len: u32) -> napi::Result<String> {
    catch_unwind_napi(|| {
        ream_security::crypto::random_bytes(len as usize)
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
    })
}

/// Generate cryptographically secure random bytes as hex.
#[napi]
pub fn random_hex(len: u32) -> napi::Result<String> {
    catch_unwind_napi(|| {
        ream_security::crypto::random_hex(len as usize)
            .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e))
    })
}

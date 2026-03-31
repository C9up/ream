//! Argon2id password hashing — timing-safe.
//!
//! @implements FR49

use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use password_hash::{rand_core::OsRng, SaltString};

/// Maximum password length in bytes (OWASP recommendation).
/// Prevents CPU DoS via oversized input to Argon2.
const MAX_PASSWORD_BYTES: usize = 1024;

/// Hash a password using Argon2id with a random salt.
/// Returns the PHC-formatted hash string.
/// Password must be <= 1024 bytes.
pub fn hash_password(password: &str) -> Result<String, String> {
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(format!("Password exceeds maximum length of {} bytes", MAX_PASSWORD_BYTES));
    }
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default(); // Argon2id v19

    argon2
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|e| format!("Argon2 hash error: {}", e))
}

/// Verify a password against an Argon2id hash.
/// Timing-safe comparison via the argon2 crate internals.
/// Password must be <= 1024 bytes.
pub fn verify_password(password: &str, hash: &str) -> Result<bool, String> {
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(format!("Password exceeds maximum length of {} bytes", MAX_PASSWORD_BYTES));
    }
    let parsed_hash = PasswordHash::new(hash).map_err(|e| format!("Invalid hash format: {}", e))?;

    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash_and_verify() {
        let password = "super_secret_password_123";
        let hash = hash_password(password).unwrap();

        // Hash should be PHC format
        assert!(hash.starts_with("$argon2"));

        // Correct password verifies
        assert!(verify_password(password, &hash).unwrap());

        // Wrong password does not verify
        assert!(!verify_password("wrong_password", &hash).unwrap());
    }

    #[test]
    fn test_different_hashes_for_same_password() {
        let hash1 = hash_password("password").unwrap();
        let hash2 = hash_password("password").unwrap();
        // Random salt means different hashes
        assert_ne!(hash1, hash2);
        // Both verify correctly
        assert!(verify_password("password", &hash1).unwrap());
        assert!(verify_password("password", &hash2).unwrap());
    }

    #[test]
    fn test_invalid_hash_format() {
        let result = verify_password("password", "not_a_valid_hash");
        assert!(result.is_err());
    }

    #[test]
    fn test_empty_password() {
        let hash = hash_password("").unwrap();
        assert!(verify_password("", &hash).unwrap());
        assert!(!verify_password("notempty", &hash).unwrap());
    }
}

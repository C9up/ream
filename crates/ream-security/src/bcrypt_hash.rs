//! Bcrypt password hashing.

const MAX_PASSWORD_BYTES: usize = 72; // bcrypt limit
const DEFAULT_COST: u32 = 12;

pub fn hash_password(password: &str, cost: Option<u32>) -> Result<String, String> {
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(format!("Password exceeds bcrypt maximum of {} bytes", MAX_PASSWORD_BYTES));
    }
    let cost = cost.unwrap_or(DEFAULT_COST);
    bcrypt::hash(password, cost).map_err(|e| format!("Bcrypt hash error: {}", e))
}

pub fn verify_password(password: &str, hash: &str) -> Result<bool, String> {
    bcrypt::verify(password, hash).map_err(|e| format!("Bcrypt verify error: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash_and_verify() {
        let hash = hash_password("password123", None).unwrap();
        assert!(hash.starts_with("$2b$"));
        assert!(verify_password("password123", &hash).unwrap());
        assert!(!verify_password("wrong", &hash).unwrap());
    }

    #[test]
    fn test_custom_cost() {
        let hash = hash_password("test", Some(4)).unwrap();
        assert!(verify_password("test", &hash).unwrap());
    }
}

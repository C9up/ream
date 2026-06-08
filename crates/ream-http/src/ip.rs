//! Client IP resolution.
//!
//! Replaces the JS-side `ipInCidr` + per-call `Request.ip({ trustedProxies })`
//! logic. The HyperServer resolves the client IP **once** while building the
//! `ReamRequest`, using a per-server trusted-proxy CIDR list, and ships the
//! resolved value to JS in `request.ip`. JS-side code just reads the field —
//! no recomputation per call.
//!
//! @implements FR47

use std::collections::HashMap;
use std::net::Ipv4Addr;

/// Resolve the client IP for a request. Inputs:
///   - `remote_addr`: socket peer (cannot be spoofed)
///   - `headers`: request headers (lowercase keys)
///   - `trusted_proxies`: CIDR ranges (or bare IPs) whose `X-Forwarded-For` /
///     `X-Real-IP` headers are honoured. **Empty by default → strict
///     fail-closed**: proxy headers are ignored entirely and the socket peer
///     is returned. Apps deployed behind a reverse proxy must list their
///     proxy's CIDR explicitly. The string sentinel `"*"` matches any peer
///     (opt into the pre-2026-05 permissive behaviour for legacy deployments
///     that can't enumerate proxy IPs — accepts spoofing as the explicit
///     trade-off).
///
/// Returns the resolved IP. Always non-empty: falls back to `127.0.0.1` if
/// no other source produced a value.
pub fn resolve_client_ip(
    remote_addr: &str,
    headers: &HashMap<String, String>,
    trusted_proxies: &[String],
) -> String {
    // Strict fail-closed when no trusted proxies are declared: never honour
    // attacker-controlled headers without an explicit operator decision.
    if trusted_proxies.is_empty() {
        return non_empty_or_default(remote_addr);
    }

    let xff_first = headers
        .get("x-forwarded-for")
        .and_then(|v| v.split(',').next())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());

    let real_ip = headers.get("x-real-ip").map(|s| s.as_str());

    // `"*"` is the explicit "trust any peer" sentinel — operators opting
    // into the pre-2026-05 permissive behaviour. Otherwise check the peer
    // against the CIDR list and refuse to honour XFF when the peer isn't on
    // the list.
    let any_trusted = trusted_proxies.iter().any(|s| s == "*");
    if !any_trusted {
        let peer_trusted = !remote_addr.is_empty()
            && trusted_proxies.iter().any(|range| ip_in_cidr(remote_addr, range));
        if !peer_trusted {
            return non_empty_or_default(remote_addr);
        }
    }

    if let Some(v) = xff_first {
        return v.to_string();
    }
    if let Some(v) = real_ip {
        if !v.is_empty() {
            return v.to_string();
        }
    }
    non_empty_or_default(remote_addr)
}

fn non_empty_or_default(s: &str) -> String {
    if s.is_empty() { "127.0.0.1".to_string() } else { s.to_string() }
}

/// True when `ip` falls inside the CIDR `range`. A bare IP (`10.0.0.42`)
/// behaves as `/32`. IPv6 falls back to string equality.
pub fn ip_in_cidr(ip: &str, cidr: &str) -> bool {
    if !cidr.contains('/') {
        return ip == cidr;
    }
    let mut parts = cidr.splitn(2, '/');
    let range = parts.next().unwrap_or("");
    let prefix_str = parts.next().unwrap_or("");
    let prefix: u32 = match prefix_str.parse() {
        Ok(n) if n <= 32 => n,
        _ => return false,
    };
    if ip.contains(':') || range.contains(':') {
        return ip == range;
    }
    let ip_n = match ip.parse::<Ipv4Addr>() {
        Ok(addr) => u32::from(addr),
        Err(_) => return false,
    };
    let range_n = match range.parse::<Ipv4Addr>() {
        Ok(addr) => u32::from(addr),
        Err(_) => return false,
    };
    if prefix == 0 {
        return true;
    }
    let mask = !0u32 << (32 - prefix);
    (ip_n & mask) == (range_n & mask)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn cidr_matches_ip_within_range() {
        assert!(ip_in_cidr("10.0.0.42", "10.0.0.0/8"));
        assert!(ip_in_cidr("10.255.255.255", "10.0.0.0/8"));
    }

    #[test]
    fn cidr_rejects_ip_outside_range() {
        assert!(!ip_in_cidr("192.168.1.1", "10.0.0.0/8"));
        assert!(!ip_in_cidr("11.0.0.1", "10.0.0.0/8"));
    }

    #[test]
    fn cidr_bare_ip_matches_only_self() {
        assert!(ip_in_cidr("10.0.0.42", "10.0.0.42"));
        assert!(!ip_in_cidr("10.0.0.43", "10.0.0.42"));
    }

    #[test]
    fn cidr_zero_prefix_matches_anything() {
        assert!(ip_in_cidr("1.2.3.4", "0.0.0.0/0"));
    }

    #[test]
    fn cidr_invalid_inputs_are_rejected() {
        assert!(!ip_in_cidr("not-an-ip", "10.0.0.0/8"));
        assert!(!ip_in_cidr("10.0.0.1", "10.0.0.0/40"));
    }

    #[test]
    fn resolve_uses_xff_when_proxy_trusted() {
        let resolved = resolve_client_ip(
            "10.0.0.42",
            &h(&[("x-forwarded-for", "203.0.113.5")]),
            &["10.0.0.0/8".into()],
        );
        assert_eq!(resolved, "203.0.113.5");
    }

    #[test]
    fn resolve_ignores_xff_when_proxy_untrusted() {
        let resolved = resolve_client_ip(
            "192.168.1.1",
            &h(&[("x-forwarded-for", "203.0.113.5")]),
            &["10.0.0.0/8".into()],
        );
        assert_eq!(resolved, "192.168.1.1");
    }

    #[test]
    fn resolve_takes_first_xff_hop() {
        let resolved = resolve_client_ip(
            "10.0.0.1",
            &h(&[("x-forwarded-for", "203.0.113.5, 10.0.0.2, 10.0.0.3")]),
            &["10.0.0.0/8".into()],
        );
        assert_eq!(resolved, "203.0.113.5");
    }

    #[test]
    fn resolve_falls_through_to_real_ip() {
        let resolved = resolve_client_ip(
            "10.0.0.1",
            &h(&[("x-real-ip", "203.0.113.42")]),
            &["10.0.0.0/8".into()],
        );
        assert_eq!(resolved, "203.0.113.42");
    }

    #[test]
    fn resolve_empty_trusted_list_ignores_xff_fails_closed() {
        // Strict fail-closed default (2026-05+): no trusted_proxies declared
        // means proxy headers are NEVER honoured. The peer socket is the
        // only IP that matters. Apps behind a reverse proxy must declare
        // their proxy's CIDR (or opt into permissive mode via `"*"`).
        let resolved = resolve_client_ip(
            "192.168.1.1",
            &h(&[("x-forwarded-for", "203.0.113.5")]),
            &[],
        );
        assert_eq!(resolved, "192.168.1.1");
    }

    #[test]
    fn resolve_star_sentinel_honours_xff_from_any_peer() {
        // Explicit opt-in to legacy permissive behaviour for operators who
        // can't enumerate their proxy CIDRs (e.g. dynamic load-balancer
        // fleets). Accepts spoofing as the documented trade-off.
        let resolved = resolve_client_ip(
            "192.168.1.1",
            &h(&[("x-forwarded-for", "203.0.113.5")]),
            &["*".into()],
        );
        assert_eq!(resolved, "203.0.113.5");
    }

    #[test]
    fn resolve_star_sentinel_alongside_cidrs_short_circuits_to_permissive() {
        // Mixed list: any single `"*"` entry promotes the whole list to
        // permissive — matches operator intent of "I know what I'm doing".
        let resolved = resolve_client_ip(
            "8.8.8.8",
            &h(&[("x-forwarded-for", "203.0.113.5")]),
            &["10.0.0.0/8".into(), "*".into()],
        );
        assert_eq!(resolved, "203.0.113.5");
    }

    #[test]
    fn resolve_falls_back_to_loopback_when_nothing_known() {
        let resolved = resolve_client_ip("", &HashMap::new(), &[]);
        assert_eq!(resolved, "127.0.0.1");
    }
}

//! Client IP resolution.
//!
//! The HyperServer resolves the client IP **once** while building the
//! `ReamRequest`, using a per-server trusted-proxy list compiled at boot, and
//! ships the resolved value to JS in `request.ip` (and the trusted chain in
//! `request.ips`). JS-side code just reads the fields.
//!
//! The walk is the one `proxy-addr` performs for `@adonisjs/http-server`
//! (`request.ip()` is `proxyaddr(req, trustProxy)`, `request.ips()` is
//! `proxyaddr.all`): the chain is the socket peer followed by the
//! `X-Forwarded-For` entries read RIGHT to LEFT, and it stops at the first hop
//! that is not a trusted proxy. Proxies append the address they saw to what
//! the client sent, so only the entries on the right were written by a proxy
//! the operator trusts; the left-most entry is whatever the client chose.
//!
//! `X-Real-IP` is not consulted, as `proxy-addr` does not consult it: it is
//! only safe behind a proxy that overwrites it, which nothing here can check.
//!
//! @implements FR47

use std::collections::HashMap;
use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Named ranges `proxy-addr` accepts in place of an address.
const NAMED_RANGES: &[(&str, &[&str])] = &[
    ("linklocal", &["169.254.0.0/16", "fe80::/10"]),
    ("loopback", &["127.0.0.1/8", "::1/128"]),
    (
        "uniquelocal",
        &["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"],
    ),
];

/// One trusted subnet: a network address and its prefix length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Subnet {
    addr: IpAddr,
    prefix: u8,
}

/// A trusted-proxy entry that could not be compiled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidProxyEntry(pub String);

impl fmt::Display for InvalidProxyEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid trusted proxy entry '{}'", self.0)
    }
}

impl std::error::Error for InvalidProxyEntry {}

/// The compiled trusted-proxy list.
///
/// Entries are IPv4 or IPv6 addresses, CIDR ranges (`10.0.0.0/8`,
/// `fd00::/8`), IPv4 netmask ranges (`10.0.0.0/255.0.0.0`), or the named
/// ranges `loopback`, `linklocal` and `uniquelocal`. The `"*"` sentinel trusts
/// every hop — the equivalent of Adonis' `trustProxy: true` — which makes the
/// left-most `X-Forwarded-For` entry the client IP and lets any client choose
/// it.
///
/// **Empty by default → strict fail-closed**: `X-Forwarded-For` is ignored and
/// the socket peer is the client IP.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TrustedProxies {
    any: bool,
    subnets: Vec<Subnet>,
}

impl TrustedProxies {
    /// Compile a list of entries. Fails on the first entry that is neither an
    /// address, a range, a named range nor `"*"`, so a typo in the operator's
    /// configuration is reported instead of silently trusting nothing.
    pub fn compile<S: AsRef<str>>(entries: &[S]) -> Result<Self, InvalidProxyEntry> {
        let mut trusted = Self::default();
        for entry in entries {
            let entry = entry.as_ref().trim();
            if entry == "*" {
                trusted.any = true;
                continue;
            }
            if let Some((_, ranges)) = NAMED_RANGES.iter().find(|(name, _)| *name == entry) {
                for range in ranges.iter() {
                    trusted.subnets.push(parse_subnet(range)?);
                }
                continue;
            }
            trusted.subnets.push(parse_subnet(entry)?);
        }
        Ok(trusted)
    }

    /// True when no proxy is trusted at all.
    pub fn is_empty(&self) -> bool {
        !self.any && self.subnets.is_empty()
    }

    /// Whether the hop `addr` is a trusted proxy. A value that is not an IP
    /// address is never trusted (except under `"*"`).
    pub fn trusts(&self, addr: &str) -> bool {
        if self.any {
            return true;
        }
        let Ok(ip) = addr.parse::<IpAddr>() else {
            return false;
        };
        self.subnets
            .iter()
            .any(|subnet| subnet_contains(subnet, ip))
    }
}

fn invalid(entry: &str) -> InvalidProxyEntry {
    InvalidProxyEntry(entry.to_string())
}

/// Parse `addr`, `addr/prefix` or `ipv4/netmask` into a subnet, as
/// `proxy-addr`'s `parseipNotation` does. A bare IPv4-mapped IPv6 address is
/// stored as IPv4. A `/0` prefix is accepted and matches its whole family.
fn parse_subnet(entry: &str) -> Result<Subnet, InvalidProxyEntry> {
    let (addr_part, range_part) = match entry.rsplit_once('/') {
        Some((addr, range)) => (addr, Some(range)),
        None => (entry, None),
    };
    let mut addr: IpAddr = addr_part.parse().map_err(|_| invalid(entry))?;
    if range_part.is_none() {
        if let IpAddr::V6(v6) = addr {
            if let Some(v4) = v6.to_ipv4_mapped() {
                addr = IpAddr::V4(v4);
            }
        }
    }
    let max: u8 = if addr.is_ipv4() { 32 } else { 128 };
    let prefix = match range_part {
        None => max,
        Some(range) if !range.is_empty() && range.bytes().all(|b| b.is_ascii_digit()) => {
            range.parse::<u8>().map_err(|_| invalid(entry))?
        }
        Some(range) => match (addr, range.parse::<Ipv4Addr>()) {
            (IpAddr::V4(_), Ok(mask)) => netmask_prefix(mask).ok_or_else(|| invalid(entry))?,
            _ => return Err(invalid(entry)),
        },
    };
    if prefix > max {
        return Err(invalid(entry));
    }
    Ok(Subnet { addr, prefix })
}

/// Prefix length of a contiguous IPv4 netmask (`255.255.0.0` → 16).
fn netmask_prefix(mask: Ipv4Addr) -> Option<u8> {
    let bits = u32::from(mask);
    let prefix = bits.leading_ones();
    // A netmask is a run of ones followed only by zeros.
    if bits.checked_shl(prefix).unwrap_or(0) != 0 {
        return None;
    }
    u8::try_from(prefix).ok()
}

/// Whether `ip` falls in `subnet`. Mixed families compare through the
/// IPv4-mapped form, as `proxy-addr` does: an IPv4 subnet matches
/// `::ffff:a.b.c.d`, an IPv6 subnet matches an IPv4 address as its mapped
/// form, and a plain IPv6 address never matches an IPv4 subnet.
fn subnet_contains(subnet: &Subnet, ip: IpAddr) -> bool {
    match (subnet.addr, ip) {
        (IpAddr::V4(net), IpAddr::V4(ip)) => v4_match(net, ip, subnet.prefix),
        (IpAddr::V6(net), IpAddr::V6(ip)) => v6_match(net, ip, subnet.prefix),
        (IpAddr::V4(net), IpAddr::V6(ip)) => match ip.to_ipv4_mapped() {
            Some(v4) => v4_match(net, v4, subnet.prefix),
            None => false,
        },
        (IpAddr::V6(net), IpAddr::V4(ip)) => v6_match(net, ip.to_ipv6_mapped(), subnet.prefix),
    }
}

fn v4_match(net: Ipv4Addr, ip: Ipv4Addr, prefix: u8) -> bool {
    let mask = u32::MAX.checked_shl(32 - u32::from(prefix)).unwrap_or(0);
    (u32::from(net) & mask) == (u32::from(ip) & mask)
}

fn v6_match(net: Ipv6Addr, ip: Ipv6Addr, prefix: u8) -> bool {
    let mask = u128::MAX.checked_shl(128 - u32::from(prefix)).unwrap_or(0);
    (u128::from(net) & mask) == (u128::from(ip) & mask)
}

/// True when `ip` falls inside `cidr` (an address, `addr/prefix` or
/// `ipv4/netmask`, IPv4 or IPv6). A bare address behaves as a single host.
/// Invalid input never matches.
pub fn ip_in_cidr(ip: &str, cidr: &str) -> bool {
    let Ok(subnet) = parse_subnet(cidr.trim()) else {
        return false;
    };
    match ip.parse::<IpAddr>() {
        Ok(addr) => subnet_contains(&subnet, addr),
        Err(_) => false,
    }
}

/// Split an `X-Forwarded-For` value the way the `forwarded` package does:
/// comma-separated, spaces around entries dropped, empty entries skipped.
/// Returned RIGHT to LEFT — closest hop first.
fn forwarded_for_reversed(header: &str) -> impl Iterator<Item = &str> {
    header
        .rsplit(',')
        .map(|entry| entry.trim_matches(' '))
        .filter(|entry| !entry.is_empty())
}

/// The trusted address chain, closest hop first: the socket peer, then each
/// `X-Forwarded-For` entry right to left while the hop before it is a trusted
/// proxy. `proxy-addr`'s `all()` — Adonis `request.ips()`.
///
/// `headers` keys are lowercase; repeated `X-Forwarded-For` lines must already
/// be joined with `", "` (see `crate::server::collect_headers`).
pub fn resolve_client_ips(
    remote_addr: &str,
    headers: &HashMap<String, String>,
    trusted: &TrustedProxies,
) -> Vec<String> {
    let socket = non_empty_or_default(remote_addr);
    let mut chain = vec![socket];
    if trusted.is_empty() {
        return chain;
    }
    let Some(header) = headers.get("x-forwarded-for") else {
        return chain;
    };
    for hop in forwarded_for_reversed(header) {
        // The last address pushed forwarded this hop: only a trusted proxy's
        // word about the next address is believed.
        let previous = chain.last().map(String::as_str).unwrap_or_default();
        if !trusted.trusts(previous) {
            break;
        }
        chain.push(hop.to_string());
    }
    chain
}

/// Resolve the client IP: the furthest address of the trusted chain —
/// `proxy-addr`, Adonis `request.ip()`. Always non-empty: an empty socket
/// address falls back to `127.0.0.1`.
pub fn resolve_client_ip(
    remote_addr: &str,
    headers: &HashMap<String, String>,
    trusted: &TrustedProxies,
) -> String {
    resolve_client_ips(remote_addr, headers, trusted)
        .pop()
        .unwrap_or_else(|| non_empty_or_default(remote_addr))
}

fn non_empty_or_default(s: &str) -> String {
    if s.is_empty() {
        "127.0.0.1".to_string()
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn trust(entries: &[&str]) -> TrustedProxies {
        TrustedProxies::compile(entries).expect("valid trusted proxies")
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
    fn cidr_matches_ipv6_ranges() {
        assert!(ip_in_cidr("2001:db8::1", "2001:db8::/32"));
        assert!(ip_in_cidr("2001:db8:ffff::1", "2001:db8::/32"));
        assert!(!ip_in_cidr("2001:db9::1", "2001:db8::/32"));
        assert!(ip_in_cidr("fd12:3456::1", "fc00::/7"));
        assert!(!ip_in_cidr("2001:db8::1", "2001:db8::/129"));
    }

    #[test]
    fn cidr_ipv6_bare_address_compares_numerically() {
        // Two spellings of the same address used to fail string equality.
        assert!(ip_in_cidr("2001:db8:0:0:0:0:0:1", "2001:db8::1"));
    }

    #[test]
    fn cidr_accepts_an_ipv4_netmask() {
        assert!(ip_in_cidr("10.1.2.3", "10.0.0.0/255.0.0.0"));
        assert!(!ip_in_cidr("11.1.2.3", "10.0.0.0/255.0.0.0"));
        assert!(!ip_in_cidr("10.1.2.3", "10.0.0.0/255.0.255.0"));
    }

    #[test]
    fn ipv4_mapped_addresses_match_ipv4_subnets() {
        assert!(ip_in_cidr("::ffff:10.0.0.7", "10.0.0.0/8"));
        assert!(ip_in_cidr("10.0.0.7", "::ffff:10.0.0.0/104"));
        assert!(!ip_in_cidr("2001:db8::1", "10.0.0.0/8"));
    }

    #[test]
    fn compile_expands_named_ranges() {
        let t = trust(&["loopback"]);
        assert!(t.trusts("127.0.0.1"));
        assert!(t.trusts("127.8.9.10"));
        assert!(t.trusts("::1"));
        assert!(!t.trusts("10.0.0.1"));

        let t = trust(&["uniquelocal", "linklocal"]);
        assert!(t.trusts("172.20.0.3"));
        assert!(t.trusts("192.168.0.1"));
        assert!(t.trusts("fd00::1"));
        assert!(t.trusts("169.254.1.1"));
        assert!(t.trusts("fe80::1"));
        assert!(!t.trusts("8.8.8.8"));
    }

    #[test]
    fn compile_rejects_invalid_entries() {
        for entry in [
            "10.0.0/8",
            "10.0.0.0/33",
            "::1/129",
            "proxy.local",
            "10.0.0.0/255.0.255.0",
            "",
        ] {
            assert!(
                TrustedProxies::compile(&[entry]).is_err(),
                "'{entry}' must not compile"
            );
        }
    }

    #[test]
    fn a_hop_that_is_not_an_ip_is_never_trusted() {
        assert!(!trust(&["10.0.0.0/8"]).trusts("unknown"));
    }

    #[test]
    fn resolve_uses_xff_when_proxy_trusted() {
        let resolved = resolve_client_ip(
            "10.0.0.42",
            &h(&[("x-forwarded-for", "203.0.113.5")]),
            &trust(&["10.0.0.0/8"]),
        );
        assert_eq!(resolved, "203.0.113.5");
    }

    #[test]
    fn resolve_ignores_xff_when_proxy_untrusted() {
        let resolved = resolve_client_ip(
            "192.168.1.1",
            &h(&[("x-forwarded-for", "203.0.113.5")]),
            &trust(&["10.0.0.0/8"]),
        );
        assert_eq!(resolved, "192.168.1.1");
    }

    #[test]
    fn resolve_ignores_a_spoofed_left_most_entry() {
        // What nginx `$proxy_add_x_forwarded_for` forwards when the client
        // sent its own header: the client's value, then the address the
        // proxy saw. Only the right-most entry was written by the proxy.
        let resolved = resolve_client_ip(
            "127.0.0.1",
            &h(&[("x-forwarded-for", "6.6.6.6, 203.0.113.9")]),
            &trust(&["127.0.0.1"]),
        );
        assert_eq!(resolved, "203.0.113.9");
    }

    #[test]
    fn resolve_walks_through_every_trusted_hop() {
        let resolved = resolve_client_ip(
            "10.0.0.1",
            &h(&[(
                "x-forwarded-for",
                "6.6.6.6, 203.0.113.5, 10.0.0.2, 10.0.0.3",
            )]),
            &trust(&["10.0.0.0/8"]),
        );
        assert_eq!(resolved, "203.0.113.5");
    }

    #[test]
    fn resolve_stops_at_the_first_untrusted_hop() {
        let ips = resolve_client_ips(
            "10.0.0.1",
            &h(&[("x-forwarded-for", "1.1.1.1, 2.2.2.2, 10.0.0.9")]),
            &trust(&["10.0.0.0/8"]),
        );
        assert_eq!(ips, vec!["10.0.0.1", "10.0.0.9", "2.2.2.2"]);
    }

    #[test]
    fn resolve_returns_the_left_most_entry_when_every_hop_is_trusted() {
        let resolved = resolve_client_ip(
            "10.0.0.1",
            &h(&[("x-forwarded-for", "10.0.0.5, 10.0.0.4")]),
            &trust(&["10.0.0.0/8"]),
        );
        assert_eq!(resolved, "10.0.0.5");
    }

    #[test]
    fn resolve_skips_empty_entries_and_spaces() {
        let resolved = resolve_client_ip(
            "10.0.0.1",
            &h(&[("x-forwarded-for", " 6.6.6.6 ,, 203.0.113.9 , ")]),
            &trust(&["10.0.0.0/8"]),
        );
        assert_eq!(resolved, "203.0.113.9");
    }

    #[test]
    fn resolve_trusts_ipv6_proxies_by_range() {
        let resolved = resolve_client_ip(
            "fd00::10",
            &h(&[("x-forwarded-for", "2001:db8::77, fd00::20")]),
            &trust(&["fd00::/8"]),
        );
        assert_eq!(resolved, "2001:db8::77");
    }

    #[test]
    fn resolve_ignores_x_real_ip() {
        // `proxy-addr` never reads X-Real-IP: a client sends it as easily as
        // any other header, and only a proxy that overwrites it makes it safe.
        let resolved = resolve_client_ip(
            "10.0.0.1",
            &h(&[("x-real-ip", "203.0.113.42")]),
            &trust(&["10.0.0.0/8"]),
        );
        assert_eq!(resolved, "10.0.0.1");
    }

    #[test]
    fn resolve_empty_trusted_list_ignores_xff_fails_closed() {
        // No trusted proxies declared → proxy headers are never honoured.
        let resolved = resolve_client_ip(
            "192.168.1.1",
            &h(&[("x-forwarded-for", "203.0.113.5")]),
            &TrustedProxies::default(),
        );
        assert_eq!(resolved, "192.168.1.1");
    }

    #[test]
    fn resolve_star_sentinel_trusts_every_hop() {
        // `"*"` is Adonis' `trustProxy: true`: every hop is trusted, so the
        // left-most entry wins — the documented trade-off of the sentinel.
        let resolved = resolve_client_ip(
            "192.168.1.1",
            &h(&[("x-forwarded-for", "203.0.113.5, 198.51.100.7")]),
            &trust(&["*"]),
        );
        assert_eq!(resolved, "203.0.113.5");
    }

    #[test]
    fn resolve_star_sentinel_alongside_cidrs_trusts_everything() {
        let resolved = resolve_client_ip(
            "8.8.8.8",
            &h(&[("x-forwarded-for", "203.0.113.5")]),
            &trust(&["10.0.0.0/8", "*"]),
        );
        assert_eq!(resolved, "203.0.113.5");
    }

    #[test]
    fn resolve_falls_back_to_loopback_when_nothing_known() {
        let resolved = resolve_client_ip("", &HashMap::new(), &TrustedProxies::default());
        assert_eq!(resolved, "127.0.0.1");
    }
}

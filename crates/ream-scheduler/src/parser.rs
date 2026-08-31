//! Cron expression parser and schedule type.
//!
//! Wraps the `cron` crate's 5-field parser. The public API exposes only
//! the local [`Schedule`] newtype so callers cannot couple to the
//! upstream crate's types.

use chrono::{DateTime, Utc};
use cron::Schedule as CronSchedule;
use ream_napi_core::ReamError;
use std::str::FromStr;

/// A parsed cron schedule. Wraps `cron::Schedule` so the public API
/// does not leak the upstream crate.
#[derive(Debug, Clone)]
pub struct Schedule {
    inner: CronSchedule,
}

impl Schedule {
    /// Compute the next fire instant strictly after `instant`.
    pub fn next_after(&self, instant: DateTime<Utc>) -> Option<DateTime<Utc>> {
        self.inner.after(&instant).next()
    }
}

/// Parse a standard 5-field cron expression.
///
/// Accepts exactly 5 fields: minute, hour, day-of-month, month, day-of-week.
/// Rejects the 6-field (seconds) and 7-field (seconds + year) variants so
/// all Ream scheduled tasks have minute-level granularity (the ticker
/// itself runs at 1 s but expressions cannot fire more than once per
/// minute).
///
/// # Timezone
///
/// The returned [`Schedule`] evaluates in **UTC** — `next_after(instant)`
/// expects and returns `DateTime<Utc>`, and the scheduler always queries
/// it with `chrono::Utc::now()`. A cron expression such as `"0 9 * * *"`
/// therefore fires at 09:00 UTC, not 09:00 local. Callers that need
/// local-time semantics must translate their cron expression (or
/// reference instant) to UTC before passing it here.
pub fn parse_cron(expr: &str) -> Result<Schedule, ReamError> {
    let trimmed = expr.trim();
    if trimmed.is_empty() {
        return Err(
            ReamError::new("INVALID_CRON", "Cron expression is empty").with_hint(
                "Standard cron format has 5 fields: minute hour day-of-month month day-of-week",
            ),
        );
    }

    let field_count = trimmed.split_whitespace().count();
    if field_count != 5 {
        return Err(ReamError::new(
            "INVALID_CRON",
            format!("Expected 5 fields, got {}", field_count),
        )
        .with_hint("Standard cron format has 5 fields: minute hour day-of-month month day-of-week")
        .with_context("expression", trimmed));
    }

    // `cron::Schedule::from_str` expects a 7-field expression with a leading
    // seconds field and trailing year. We prepend "0" (fire at second 0)
    // and append "*" (any year) so the user-facing grammar stays 5 fields.
    let normalized = format!("0 {} *", trimmed);
    let inner = CronSchedule::from_str(&normalized).map_err(|e| {
        ReamError::new(
            "INVALID_CRON",
            format!("Failed to parse cron expression: {}", e),
        )
        .with_hint("Check field ranges: minute 0-59, hour 0-23, dom 1-31, month 1-12, dow 0-6")
        .with_context("expression", trimmed)
    })?;

    Ok(Schedule { inner })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn parses_standard_five_field_expression() {
        let schedule = parse_cron("0 */5 * * *").expect("should parse");
        let base = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let next = schedule.next_after(base).expect("has next");
        assert!(next > base);
    }

    #[test]
    fn every_five_minutes_advances_by_five_minutes() {
        let schedule = parse_cron("*/5 * * * *").expect("should parse");
        let base = Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap();
        let next = schedule.next_after(base).expect("has next");
        assert_eq!((next - base).num_minutes(), 5);
    }

    #[test]
    fn leap_year_feb_29_advances_to_next_leap_year() {
        let schedule = parse_cron("0 0 29 2 *").expect("should parse");
        let base = Utc.with_ymd_and_hms(2025, 1, 1, 0, 0, 0).unwrap();
        let next = schedule.next_after(base).expect("has next");
        assert_eq!(next.format("%Y-%m-%d").to_string(), "2028-02-29");
    }

    #[test]
    fn daily_midnight_advances_24h_in_utc() {
        let schedule = parse_cron("0 0 * * *").expect("should parse");
        let base = Utc.with_ymd_and_hms(2026, 3, 29, 0, 0, 0).unwrap();
        let next = schedule.next_after(base).expect("has next");
        assert_eq!((next - base).num_hours(), 24);
    }

    #[test]
    fn rejects_four_fields() {
        let err = parse_cron("0 */5 * *").expect_err("should reject");
        assert_eq!(err.code, "INVALID_CRON");
        assert!(err.message.contains("Expected 5"));
        assert!(err.hint.as_deref().unwrap_or("").contains("5 fields"));
    }

    #[test]
    fn rejects_six_fields() {
        let err = parse_cron("* * * * * *").expect_err("should reject");
        assert_eq!(err.code, "INVALID_CRON");
    }

    #[test]
    fn rejects_out_of_range_minute() {
        let err = parse_cron("99 * * * *").expect_err("should reject");
        assert_eq!(err.code, "INVALID_CRON");
    }

    #[test]
    fn rejects_garbage() {
        let err = parse_cron("not a cron").expect_err("should reject");
        assert_eq!(err.code, "INVALID_CRON");
    }

    #[test]
    fn rejects_empty_string() {
        let err = parse_cron("").expect_err("should reject");
        assert_eq!(err.code, "INVALID_CRON");
    }

    #[test]
    fn rejects_whitespace_only() {
        let err = parse_cron("    ").expect_err("should reject");
        assert_eq!(err.code, "INVALID_CRON");
    }
}

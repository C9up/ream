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
    //
    // The day-of-week field is TRANSLATED, not passed through. Standard cron —
    // and this crate's documented range — numbers it 0-6 with 0 = Sunday. The
    // `cron` crate numbers it 1-7 with 1 = Sunday, and it has not always: under
    // cron 0.12 a bare `5` meant Friday, under 0.17 it means Thursday. Passing
    // the field through would have shifted every weekly job in every
    // application by one day, silently, on a dependency bump.
    let fields: Vec<&str> = trimmed.split_whitespace().collect();
    let dow = shift_day_of_week(fields[4])?;
    let normalized = format!(
        "0 {} {} {} {} {} *",
        fields[0], fields[1], fields[2], fields[3], dow
    );
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

/// Translate a 0-6 (Sunday = 0) day-of-week field into the `cron` crate's
/// 1-7 (Sunday = 1), leaving names, wildcards and steps alone.
///
/// Ranges and lists have to be walked rather than the whole field replaced:
/// `1-5` (Monday to Friday) is `2-6` on the other side, and `0,6` (the
/// weekend) is `1,7`.
fn shift_day_of_week(field: &str) -> Result<String, ReamError> {
    let shift_one = |token: &str| -> Result<String, ReamError> {
        let Ok(n) = token.parse::<u8>() else {
            // A name (`SUN`), a wildcard, or something the crate will reject
            // with its own message.
            return Ok(token.to_string());
        };
        if n > 6 {
            return Err(ReamError::new(
                "INVALID_CRON",
                format!("Day-of-week must be 0-6 (0 = Sunday), got {n}"),
            )
            .with_hint("Use 0-6 or a name such as SUN; 7 is not a second spelling of Sunday here.")
            .with_context("field", field));
        }
        Ok((n + 1).to_string())
    };

    let mut parts = Vec::new();
    for list_item in field.split(',') {
        // A step (`*/2`, `1-5/2`) keeps its divisor: it counts positions, not
        // weekdays, so shifting it would change the stride.
        let (spec, step) = match list_item.split_once('/') {
            Some((spec, step)) => (spec, Some(step)),
            None => (list_item, None),
        };
        let shifted = match spec.split_once('-') {
            Some((from, to)) => format!("{}-{}", shift_one(from)?, shift_one(to)?),
            None => shift_one(spec)?,
        };
        parts.push(match step {
            Some(step) => format!("{shifted}/{step}"),
            None => shifted,
        });
    }
    Ok(parts.join(","))
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
    fn day_of_week_numbering_is_sunday_zero() {
        // The field whose convention differs between cron implementations —
        // 0 or 1 for Sunday, and whether 7 is accepted as Sunday too. Nothing
        // else here exercises it, so a dependency bump could renumber every
        // weekly job by a day and every other test would still pass.
        let sunday = parse_cron("0 0 * * 0").expect("0 parses as a weekday");
        let base = Utc.with_ymd_and_hms(2026, 3, 2, 0, 0, 0).unwrap(); // a Monday
        let next = sunday.next_after(base).expect("has next");
        assert_eq!(
            next.format("%Y-%m-%d %A").to_string(),
            "2026-03-08 Sunday",
            "0 must mean Sunday"
        );

        let friday = parse_cron("30 13 * * 5").expect("5 parses as a weekday");
        let next = friday.next_after(base).expect("has next");
        assert_eq!(
            next.format("%Y-%m-%d %A %H:%M").to_string(),
            "2026-03-06 Friday 13:30",
            "5 must mean Friday, at the requested time"
        );
    }

    #[test]
    fn day_of_week_ranges_lists_and_steps_are_translated_too() {
        // A whole-field substitution would have handled `5` and corrupted
        // `1-5`, which is the spelling most weekday schedules actually use.
        let base = Utc.with_ymd_and_hms(2026, 3, 7, 12, 0, 0).unwrap(); // a Saturday

        let weekdays = parse_cron("0 9 * * 1-5").expect("range parses");
        assert_eq!(
            weekdays
                .next_after(base)
                .expect("has next")
                .format("%Y-%m-%d %A")
                .to_string(),
            "2026-03-09 Monday",
            "1-5 must be Monday through Friday"
        );

        let weekend = parse_cron("0 9 * * 0,6").expect("list parses");
        assert_eq!(
            weekend
                .next_after(base)
                .expect("has next")
                .format("%A")
                .to_string(),
            "Sunday",
            "0,6 must be the weekend, and Sunday is the next one from Saturday noon"
        );

        // A name is left alone — the crate already reads it correctly.
        let named = parse_cron("0 9 * * WED").expect("name parses");
        assert_eq!(
            named
                .next_after(base)
                .expect("has next")
                .format("%A")
                .to_string(),
            "Wednesday"
        );

        // Out of range is refused with our own message, not the crate's
        // off-by-one one.
        let err = parse_cron("0 9 * * 7").expect_err("7 is out of range");
        assert!(
            err.to_string().contains("0-6"),
            "the error should name the documented range, got: {err}"
        );
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

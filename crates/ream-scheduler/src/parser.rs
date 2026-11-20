//! Cron expression parser and schedule type.
//!
//! The grammar and the next-fire search are implemented here, on `jiff`,
//! rather than borrowed from a cron crate: the expressions ream accepts are a
//! small, fixed set, and owning them keeps a dependency bump from changing
//! which day a weekly job runs on (see `day_of_week` below for the time that
//! nearly happened).
//!
//! # Grammar
//!
//! Exactly five whitespace-separated fields: minute (0-59), hour (0-23),
//! day-of-month (1-31), month (1-12) and day-of-week (0-6, 0 = Sunday). Each
//! field is a comma-separated list of items, and an item is one of:
//!
//! - `*` — every value of the field;
//! - `N` — one value;
//! - `N-M` — an inclusive range, `N <= M` (no wrap-around);
//! - a name (month `JAN`..`DEC` or `JANUARY`.., weekday `SUN`..`SAT`,
//!   `SUNDAY`.., `TUES`, `THURS`), case-insensitive, and a range of two names;
//! - any of the above except a lone name followed by `/S`: every S-th value of
//!   `*`, of the range, or from `N` to the end of the field. `S` runs from 1 to
//!   the field's maximum (7 for the day of week).
//!
//! `?` is a second spelling of `*` in the day-of-month and day-of-week fields
//! only. `L`, `W`, `#`, `@daily` and the like are not supported.
//!
//! A time fires when every field matches it: when both the day of month and
//! the day of week are restricted, a day has to satisfy both (`0 0 13 * 5`
//! is Friday the 13th, not every 13th and every Friday).
//!
//! # Timezone
//!
//! Schedules evaluate in **UTC**: `next_after(instant)` takes and returns a
//! [`Timestamp`], and the scheduler always queries it with
//! `Timestamp::now()`. `"0 9 * * *"` therefore fires at 09:00 UTC, every day,
//! with no daylight-saving gap or repeat. Callers that need local-time
//! semantics must translate the expression before passing it here.

use jiff::civil::{self, Date};
use jiff::tz::Offset;
use jiff::Timestamp;
use ream_napi_core::ReamError;

/// The first and last years the next-fire search looks at. A schedule with no
/// fire in that window — `0 0 30 2 *`, or a Feb 29 that has to be a Monday
/// after 2072 — has no next fire.
const FIRST_YEAR: i16 = 1970;
const LAST_YEAR: i16 = 2100;

const FIELDS_HINT: &str =
    "Standard cron format has 5 fields: minute hour day-of-month month day-of-week";
const RANGES_HINT: &str =
    "Check field ranges: minute 0-59, hour 0-23, dom 1-31, month 1-12, dow 0-6";

/// The set of values one field matches, as a bit mask indexed by value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FieldSet(u64);

impl FieldSet {
    fn contains(self, value: i8) -> bool {
        (0..64).contains(&value) && self.0 & (1 << value) != 0
    }

    /// The smallest value in the set that is `>= from`, if any.
    fn first_from(self, from: i8) -> Option<i8> {
        if !(0..64).contains(&from) {
            return None;
        }
        let rest = self.0 >> from;
        if rest == 0 {
            return None;
        }
        i8::try_from(rest.trailing_zeros())
            .ok()
            .map(|offset| from + offset)
    }
}

/// A parsed cron schedule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Schedule {
    minutes: FieldSet,
    hours: FieldSet,
    days_of_month: FieldSet,
    months: FieldSet,
    days_of_week: FieldSet,
}

impl Schedule {
    /// Compute the next fire instant strictly after `instant`, or `None` when
    /// the schedule has no fire left before the end of [`LAST_YEAR`].
    pub fn next_after(&self, instant: Timestamp) -> Option<Timestamp> {
        let now = Offset::UTC.to_datetime(instant);
        // Fires are whole minutes, so the first candidate is the minute after
        // the one `instant` falls in: a fire at exactly `instant` is not
        // strictly after it, and one later in the same minute does not exist.
        let start = now
            .date()
            .at(now.hour(), now.minute(), 0, 0)
            .checked_add(jiff::SignedDuration::from_mins(1))
            .ok()?;
        let fire = self.first_fire_from(start)?;
        Offset::UTC.to_timestamp(fire).ok()
    }

    /// The first civil minute `>= start` every field matches.
    ///
    /// Walks from the largest unit down. Whenever a unit has to move forward,
    /// every smaller one restarts at its minimum; whenever one runs out, the
    /// next larger one moves forward by one and the walk starts over from it.
    fn first_fire_from(&self, start: civil::DateTime) -> Option<civil::DateTime> {
        let (mut year, mut month, mut day, mut hour, mut minute) = if start.year() < FIRST_YEAR {
            (FIRST_YEAR, 1, 1, 0, 0)
        } else {
            (
                start.year(),
                start.month(),
                start.day(),
                start.hour(),
                start.minute(),
            )
        };

        while year <= LAST_YEAR {
            let Some(m) = self.months.first_from(month) else {
                (year, month, day, hour, minute) = (year + 1, 1, 1, 0, 0);
                continue;
            };
            if m != month {
                (month, day, hour, minute) = (m, 1, 0, 0);
            }

            let Some(d) = self.first_day_from(year, month, day) else {
                (month, day, hour, minute) = (month + 1, 1, 0, 0);
                continue;
            };
            if d != day {
                (day, hour, minute) = (d, 0, 0);
            }

            let Some(h) = self.hours.first_from(hour) else {
                (day, hour, minute) = (day + 1, 0, 0);
                continue;
            };
            if h != hour {
                (hour, minute) = (h, 0);
            }

            let Some(min) = self.minutes.first_from(minute) else {
                (hour, minute) = (hour + 1, 0);
                continue;
            };
            return Date::new(year, month, day)
                .ok()
                .map(|date| date.at(hour, min, 0, 0));
        }
        None
    }

    /// The first day `>= from` of `year`-`month` that both day fields match.
    fn first_day_from(&self, year: i16, month: i8, from: i8) -> Option<i8> {
        let last = Date::new(year, month, 1).ok()?.days_in_month();
        (from..=last).find(|&day| {
            self.days_of_month.contains(day)
                && Date::new(year, month, day).is_ok_and(|date| {
                    self.days_of_week
                        .contains(date.weekday().to_sunday_zero_offset())
                })
        })
    }
}

/// How one of the five fields is read.
struct FieldSpec {
    name: &'static str,
    min: u8,
    max: u8,
    /// The largest step `/S` accepts. The field maximum, except for the day of
    /// week, which kept the 7 of the 1-7 numbering it used to be parsed in.
    max_step: u8,
    names: &'static [(&'static str, u8)],
    /// Whether `?` stands for `*` here.
    allows_any: bool,
}

const MINUTE: FieldSpec = FieldSpec {
    name: "minute",
    min: 0,
    max: 59,
    max_step: 59,
    names: &[],
    allows_any: false,
};

const HOUR: FieldSpec = FieldSpec {
    name: "hour",
    min: 0,
    max: 23,
    max_step: 23,
    names: &[],
    allows_any: false,
};

const DAY_OF_MONTH: FieldSpec = FieldSpec {
    name: "day-of-month",
    min: 1,
    max: 31,
    max_step: 31,
    names: &[],
    allows_any: true,
};

const MONTH: FieldSpec = FieldSpec {
    name: "month",
    min: 1,
    max: 12,
    max_step: 12,
    names: &[
        ("jan", 1),
        ("january", 1),
        ("feb", 2),
        ("february", 2),
        ("mar", 3),
        ("march", 3),
        ("apr", 4),
        ("april", 4),
        ("may", 5),
        ("jun", 6),
        ("june", 6),
        ("jul", 7),
        ("july", 7),
        ("aug", 8),
        ("august", 8),
        ("sep", 9),
        ("september", 9),
        ("oct", 10),
        ("october", 10),
        ("nov", 11),
        ("november", 11),
        ("dec", 12),
        ("december", 12),
    ],
    allows_any: false,
};

/// Numbered 0-6 with 0 = Sunday, as standard cron documents it. This is the
/// field whose convention differs between cron implementations — 0 or 1 for
/// Sunday, and whether 7 is a second Sunday — and the `cron` crate this parser
/// replaced renumbered it between two releases.
const DAY_OF_WEEK: FieldSpec = FieldSpec {
    name: "day-of-week",
    min: 0,
    max: 6,
    max_step: 7,
    names: &[
        ("sun", 0),
        ("sunday", 0),
        ("mon", 1),
        ("monday", 1),
        ("tue", 2),
        ("tues", 2),
        ("tuesday", 2),
        ("wed", 3),
        ("wednesday", 3),
        ("thu", 4),
        ("thurs", 4),
        ("thursday", 4),
        ("fri", 5),
        ("friday", 5),
        ("sat", 6),
        ("saturday", 6),
    ],
    allows_any: true,
};

/// Parse a standard 5-field cron expression.
///
/// Accepts exactly 5 fields: minute, hour, day-of-month, month, day-of-week
/// (see the module documentation for the grammar). Rejects the 6-field
/// (seconds) and 7-field (seconds + year) variants so all Ream scheduled
/// tasks have minute-level granularity (the ticker itself runs at 1 s but
/// expressions cannot fire more than once per minute).
pub fn parse_cron(expr: &str) -> Result<Schedule, ReamError> {
    let trimmed = expr.trim();
    if trimmed.is_empty() {
        return Err(
            ReamError::new("INVALID_CRON", "Cron expression is empty").with_hint(FIELDS_HINT)
        );
    }

    let fields: Vec<&str> = trimmed.split_whitespace().collect();
    let &[minute, hour, day_of_month, month, day_of_week] = fields.as_slice() else {
        return Err(ReamError::new(
            "INVALID_CRON",
            format!("Expected 5 fields, got {}", fields.len()),
        )
        .with_hint(FIELDS_HINT)
        .with_context("expression", trimmed));
    };

    let parse = |spec: &FieldSpec, field: &str| {
        parse_field(spec, field).map_err(|error| error.with_context("expression", trimmed))
    };
    Ok(Schedule {
        minutes: parse(&MINUTE, minute)?,
        hours: parse(&HOUR, hour)?,
        days_of_month: parse(&DAY_OF_MONTH, day_of_month)?,
        months: parse(&MONTH, month)?,
        days_of_week: parse(&DAY_OF_WEEK, day_of_week)?,
    })
}

fn parse_field(spec: &FieldSpec, field: &str) -> Result<FieldSet, ReamError> {
    let mut set = 0u64;
    for item in field.split(',') {
        for value in parse_item(spec, field, item)? {
            set |= 1 << value;
        }
    }
    Ok(FieldSet(set))
}

/// The values one list item stands for.
fn parse_item(
    spec: &FieldSpec,
    field: &str,
    item: &str,
) -> Result<std::iter::StepBy<std::ops::RangeInclusive<u8>>, ReamError> {
    let invalid = |message: String| {
        ReamError::new("INVALID_CRON", message)
            .with_hint(RANGES_HINT)
            .with_context("field", field)
    };

    let (base, step) = match item.split_once('/') {
        Some((base, step)) => {
            let step = parse_number(step)
                .filter(|step| (1..=u32::from(spec.max_step)).contains(step))
                .ok_or_else(|| {
                    invalid(format!(
                        "Invalid step '{step}' in the {} field: expected a number from 1 to {}",
                        spec.name, spec.max_step
                    ))
                })?;
            (base, Some(step))
        }
        None => (item, None),
    };

    let (first, last) = if base == "*" || (spec.allows_any && base == "?") {
        (spec.min, spec.max)
    } else if let Some((from, to)) = base.split_once('-') {
        // Two numbers or two names: `MON-5` is a typo more often than a range.
        if is_number(from) != is_number(to) {
            return Err(invalid(format!(
                "Invalid range '{base}' in the {} field: mix of a name and a number",
                spec.name
            )));
        }
        let from = parse_value(spec, field, from)?;
        let to = parse_value(spec, field, to)?;
        if from > to {
            return Err(invalid(format!(
                "Invalid range '{base}' in the {} field: the start is after the end",
                spec.name
            )));
        }
        (from, to)
    } else if is_number(base) {
        // A single number, and with a step it starts a run to the field's end.
        let from = parse_value(spec, field, base)?;
        (from, if step.is_some() { spec.max } else { from })
    } else {
        if step.is_some() {
            return Err(invalid(format!(
                "Invalid step on '{base}' in the {} field: a step applies to `*`, a range or a number",
                spec.name
            )));
        }
        let value = parse_value(spec, field, base)?;
        (value, value)
    };

    let step = usize::try_from(step.unwrap_or(1)).unwrap_or(usize::MAX);
    Ok((first..=last).step_by(step))
}

/// One number or name, checked against the field's range.
fn parse_value(spec: &FieldSpec, field: &str, token: &str) -> Result<u8, ReamError> {
    let invalid = |message: String| {
        ReamError::new("INVALID_CRON", message)
            .with_hint(RANGES_HINT)
            .with_context("field", field)
    };

    if !token.is_empty() && token.bytes().all(|b| b.is_ascii_alphabetic()) {
        let lower = token.to_ascii_lowercase();
        return spec
            .names
            .iter()
            .find(|(name, _)| *name == lower)
            .map(|&(_, value)| value)
            .ok_or_else(|| {
                invalid(if spec.names.is_empty() {
                    format!(
                        "The {} field does not accept names, got '{token}'",
                        spec.name
                    )
                } else {
                    format!("'{token}' is not a valid {} name", spec.name)
                })
            });
    }

    let Some(number) = parse_number(token) else {
        return Err(invalid(format!(
            "Invalid value '{token}' in the {} field",
            spec.name
        )));
    };
    match u8::try_from(number) {
        Ok(value) if (spec.min..=spec.max).contains(&value) => Ok(value),
        _ if spec.name == DAY_OF_WEEK.name => Err(invalid(format!(
            "Day-of-week must be 0-6 (0 = Sunday), got {number}"
        ))
        .with_hint("Use 0-6 or a name such as SUN; 7 is not a second spelling of Sunday here.")),
        _ => Err(invalid(format!(
            "The {} field must be {}-{}, got {number}",
            spec.name, spec.min, spec.max
        ))),
    }
}

/// Whether `token` is spelled as a number: ASCII digits only, no sign.
fn is_number(token: &str) -> bool {
    !token.is_empty() && token.bytes().all(|b| b.is_ascii_digit())
}

/// A number as [`is_number`] spells it, read as a `u32`.
fn parse_number(token: &str) -> Option<u32> {
    if !is_number(token) {
        return None;
    }
    token.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(rfc3339: &str) -> Timestamp {
        rfc3339.parse().expect("valid fixture instant")
    }

    fn day(ts: Timestamp) -> String {
        ts.strftime("%Y-%m-%d %A").to_string()
    }

    #[test]
    fn parses_standard_five_field_expression() {
        let schedule = parse_cron("0 */5 * * *").expect("should parse");
        let base = at("2026-01-01T00:00:00Z");
        let next = schedule.next_after(base).expect("has next");
        assert!(next > base);
    }

    #[test]
    fn every_five_minutes_advances_by_five_minutes() {
        let schedule = parse_cron("*/5 * * * *").expect("should parse");
        let base = at("2026-01-01T00:00:00Z");
        let next = schedule.next_after(base).expect("has next");
        assert_eq!(next.duration_since(base).as_mins(), 5);
    }

    #[test]
    fn day_of_week_numbering_is_sunday_zero() {
        // The field whose convention differs between cron implementations —
        // 0 or 1 for Sunday, and whether 7 is accepted as Sunday too. Nothing
        // else here exercises it, so a change could renumber every weekly job
        // by a day and every other test would still pass.
        let sunday = parse_cron("0 0 * * 0").expect("0 parses as a weekday");
        let base = at("2026-03-02T00:00:00Z"); // a Monday
        let next = sunday.next_after(base).expect("has next");
        assert_eq!(day(next), "2026-03-08 Sunday", "0 must mean Sunday");

        let friday = parse_cron("30 13 * * 5").expect("5 parses as a weekday");
        let next = friday.next_after(base).expect("has next");
        assert_eq!(
            next.strftime("%Y-%m-%d %A %H:%M").to_string(),
            "2026-03-06 Friday 13:30",
            "5 must mean Friday, at the requested time"
        );
    }

    #[test]
    fn day_of_week_ranges_lists_and_names() {
        let base = at("2026-03-07T12:00:00Z"); // a Saturday

        let weekdays = parse_cron("0 9 * * 1-5").expect("range parses");
        assert_eq!(
            day(weekdays.next_after(base).expect("has next")),
            "2026-03-09 Monday",
            "1-5 must be Monday through Friday"
        );

        let weekend = parse_cron("0 9 * * 0,6").expect("list parses");
        assert_eq!(
            day(weekend.next_after(base).expect("has next")),
            "2026-03-08 Sunday",
            "0,6 must be the weekend, and Sunday is the next one from Saturday noon"
        );

        let named = parse_cron("0 9 * * WED").expect("name parses");
        assert_eq!(
            day(named.next_after(base).expect("has next")),
            "2026-03-11 Wednesday"
        );

        let err = parse_cron("0 9 * * 7").expect_err("7 is out of range");
        assert!(
            err.to_string().contains("0-6"),
            "the error should name the documented range, got: {err}"
        );
    }

    #[test]
    fn leap_year_feb_29_advances_to_next_leap_year() {
        let schedule = parse_cron("0 0 29 2 *").expect("should parse");
        let next = schedule
            .next_after(at("2025-01-01T00:00:00Z"))
            .expect("has next");
        assert_eq!(day(next), "2028-02-29 Tuesday");
    }

    #[test]
    fn daily_midnight_advances_24h_in_utc() {
        let schedule = parse_cron("0 0 * * *").expect("should parse");
        let base = at("2026-03-29T00:00:00Z");
        let next = schedule.next_after(base).expect("has next");
        assert_eq!(next.duration_since(base).as_hours(), 24);
    }

    #[test]
    fn impossible_date_never_fires() {
        let schedule = parse_cron("0 0 30 2 *").expect("Feb 30 parses");
        assert_eq!(schedule.next_after(at("2026-01-01T00:00:00Z")), None);
    }

    #[test]
    fn search_stops_after_the_last_year() {
        let schedule = parse_cron("* * * * *").expect("should parse");
        assert_eq!(
            schedule.next_after(at("2100-12-31T23:58:30Z")),
            Some(at("2100-12-31T23:59:00Z"))
        );
        assert_eq!(schedule.next_after(at("2100-12-31T23:59:00Z")), None);
        assert_eq!(schedule.next_after(Timestamp::MAX), None);
    }

    #[test]
    fn far_past_instant_starts_at_the_first_year() {
        let schedule = parse_cron("0 0 1 1 *").expect("should parse");
        assert_eq!(
            schedule.next_after(Timestamp::MIN),
            Some(at("1970-01-01T00:00:00Z"))
        );
    }

    #[test]
    fn a_separator_cannot_glue_two_fields_together() {
        // The `cron` crate this parser replaced let a list, range or step
        // separator at the start of a field attach to the field before it:
        // `,1 * * * *` was read as seconds `0,1` with every field shifted one
        // place left. A sign was let through on day-of-week numbers.
        for expr in [
            ",1 * * * *",
            "-1 * * * *",
            "/5 * * * *",
            "0 ,5 * * *",
            "0 0 * * +5",
            "+5 * * * *",
        ] {
            let err = parse_cron(expr).expect_err(expr);
            assert_eq!(err.code, "INVALID_CRON", "{expr}");
        }
    }

    #[test]
    fn errors_name_the_field_and_the_expression() {
        let err = parse_cron("0 24 * * *").expect_err("hour 24");
        assert!(err.message.contains("hour"), "{}", err.message);
        assert_eq!(
            err.context.get("expression").map(String::as_str),
            Some("0 24 * * *")
        );
        assert_eq!(err.context.get("field").map(String::as_str), Some("24"));

        let err = parse_cron("0 0 * * MON/2").expect_err("step on a name");
        assert!(err.message.contains("step"), "{}", err.message);
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

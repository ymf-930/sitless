//! SQLite 存储：坐姿段的落库与聚合查询
//!
//! 写入策略（决策）：当前段每 60s UPSERT 一次，段结束时定稿（closed=1）。
//! 主键用段起点的本地时间字符串，保证同一段反复 UPSERT 不会产生重复行。

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, Result as SqlResult, params};
use serde::Serialize;

pub struct Db {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct Today {
    pub day: String,
    /// 当日坐姿总时长（含未闭合的当前段）
    pub sitting_ms: i64,
    /// 当日最长连续段
    pub longest_ms: i64,
    /// 段数
    pub segments: i64,
    /// 当日真实弹过的提醒次数（轻提醒 + 警戒），预览不计入
    pub reminders: i64,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct SegmentRow {
    pub started_at: String,
    pub sitting_ms: i64,
    pub closed: bool,
    /// 段结束原因：away / dismiss（真起身）、midnight / exit / stale（只是结算）、
    /// unknown（旧数据，分不清）、open（未闭合）
    pub end_reason: String,
}

/// 导出用的完整段明细
#[derive(Debug, Clone, Serialize)]
pub struct SegmentFull {
    pub started_at: String,
    pub day: String,
    pub sitting_ms: i64,
    pub continuous_ms: i64,
    pub closed: bool,
    pub end_reason: String,
}

/// 进程退出时留下的未闭合段，供下次启动判断能否续接
#[derive(Debug, Clone)]
pub struct OpenSegment {
    pub started_at: String,
    pub day: String,
    pub sitting_ms: i64,
    /// 最后一次快照的墙钟时间，和当前时间差得远说明中间关机了
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct DayRow {
    pub day: String,
    pub sitting_ms: i64,
    pub longest_ms: i64,
}

/// 历史页用的每日聚合，比导出用的 DayRow 多段数 / 起身次数 / 提醒次数
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct TrendRow {
    pub day: String,
    pub sitting_ms: i64,
    pub longest_ms: i64,
    pub segments: i64,
    pub rises: i64,
    pub reminders: i64,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS segment (
    started_at    TEXT PRIMARY KEY,
    day           TEXT NOT NULL,
    sitting_ms    INTEGER NOT NULL,
    continuous_ms INTEGER NOT NULL,
    closed        INTEGER NOT NULL DEFAULT 0,
    end_reason    TEXT NOT NULL DEFAULT '',
    updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segment_day ON segment(day);

CREATE TABLE IF NOT EXISTS setting (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reminder (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    day   TEXT NOT NULL,
    kind  TEXT NOT NULL,
    at    TEXT NOT NULL,
    style INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_reminder_day ON reminder(day);
"#;

/// 结构版本号，存在 `PRAGMA user_version` 里；每次改表 +1 并在 `migrate` 补一段。
/// v1：reminder.style（提醒窗口形态）、segment.end_reason（段结束原因）
/// v2：把「一分钟上下」的历史闭合段标成 stale，别把重启残段算成起身
/// v3：清掉零长度的空段（曾经在「启动即离座」时落过一条）
const SCHEMA_VERSION: i64 = 3;

fn user_version(conn: &rusqlite::Connection) -> SqlResult<i64> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
}

/// 探列后补列：老库缺列时补上，已有的数据不受影响
fn add_column(
    conn: &rusqlite::Connection,
    table: &str,
    column: &str,
    decl: &str,
) -> SqlResult<()> {
    let cols: Vec<String> = {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        stmt.query_map([], |r| r.get::<_, String>(1))?
            .collect::<SqlResult<Vec<_>>>()?
    };
    if !cols.iter().any(|c| c == column) {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"))?;
    }
    Ok(())
}

fn migrate(conn: &rusqlite::Connection) -> SqlResult<()> {
    let from = user_version(conn)?;
    if from >= SCHEMA_VERSION {
        return Ok(());
    }
    if from < 1 {
        add_column(conn, "reminder", "style", "INTEGER NOT NULL DEFAULT 0")?;
        add_column(conn, "segment", "end_reason", "TEXT NOT NULL DEFAULT ''")?;
        // 未闭合的段一定是还在进行，记 open
        conn.execute_batch(
            "UPDATE segment SET end_reason = 'open' WHERE closed = 0 AND end_reason = ''",
        )?;
        // 已闭合的旧段：能确定是跨零点结算的标 midnight（结束时刻必然落在 24:00 附近），
        // 其余分不清起身与退出，先记 unknown
        let rows: Vec<(String, i64)> = {
            let mut stmt = conn.prepare(
                "SELECT started_at, sitting_ms FROM segment WHERE closed = 1 AND end_reason = ''",
            )?;
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<SqlResult<Vec<_>>>()?
        };
        let mut upd = conn.prepare("UPDATE segment SET end_reason = ?2 WHERE started_at = ?1")?;
        for (started_at, ms) in rows {
            let reason = if ends_at_midnight(&started_at, ms) {
                "midnight"
            } else {
                "unknown"
            };
            upd.execute(params![started_at, reason])?;
        }
    }
    if from < 2 {
        // 一分钟上下的已闭合旧段，几乎都是反复重启留下的残段：没人坐 90 秒就起身。
        // 新写入的段不受影响，真实起身仍按 away / dismiss 记。
        conn.execute(
            "UPDATE segment SET end_reason = 'stale'
             WHERE end_reason = 'unknown' AND closed = 1 AND sitting_ms <= 90000",
            [],
        )?;
    }
    if from < 3 {
        // 零长度的段没有任何信息量，还会在时间线上显示「坐了 0 分钟」
        conn.execute("DELETE FROM segment WHERE sitting_ms <= 0", [])?;
    }
    conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))?;
    Ok(())
}

/// 这一段是否在零点整被结算（跨零点切段）
fn ends_at_midnight(started_at: &str, sitting_ms: i64) -> bool {
    use chrono::Timelike;
    let Some(start) = parse_at(started_at) else {
        return false;
    };
    let secs = (start + chrono::Duration::milliseconds(sitting_ms))
        .time()
        .num_seconds_from_midnight();
    secs >= 23 * 3600 + 59 * 60 + 30 || secs <= 30
}

/// 段起点可能是秒级（旧数据）也可能带毫秒（新数据），两种都要认
pub fn parse_at(iso: &str) -> Option<chrono::NaiveDateTime> {
    chrono::NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S%.3f")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S"))
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(iso.get(..19)?, "%Y-%m-%dT%H:%M:%S").ok()
        })
}

impl Db {
    pub fn open(path: &Path) -> SqlResult<Self> {
        let conn = Connection::open(path)?;
        Self::prepare(conn)
    }

    #[cfg(test)]
    pub fn in_memory() -> SqlResult<Self> {
        let conn = Connection::open_in_memory()?;
        Self::prepare(conn)
    }

    fn prepare(conn: Connection) -> SqlResult<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
        )?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// 快照写入；段结束时把 closed 置 1 并记下结束原因
    #[allow(clippy::too_many_arguments)]
    pub fn save_segment(
        &self,
        started_at: &str,
        day: &str,
        sitting_ms: i64,
        continuous_ms: i64,
        closed: bool,
        end_reason: &str,
        now_iso: &str,
    ) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO segment (started_at, day, sitting_ms, continuous_ms, closed, end_reason, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(started_at) DO UPDATE SET
                sitting_ms    = excluded.sitting_ms,
                continuous_ms = excluded.continuous_ms,
                closed        = excluded.closed,
                end_reason    = excluded.end_reason,
                updated_at    = excluded.updated_at
            "#,
            params![
                started_at,
                day,
                sitting_ms,
                continuous_ms,
                closed as i32,
                end_reason,
                now_iso
            ],
        )?;
        Ok(())
    }

    /// 读取全部配置项，缺失的键由调用方给默认值
    pub fn settings(&self) -> SqlResult<std::collections::HashMap<String, String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT key, value FROM setting")?;
        let map = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<SqlResult<std::collections::HashMap<_, _>>>()?;
        Ok(map)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO setting (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// 最后一条未闭合的段（进程退出时留下的）。用于启动时判断能否续接
    pub fn open_segment(&self) -> SqlResult<Option<OpenSegment>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT started_at, day, sitting_ms, updated_at FROM segment
             WHERE closed = 0 ORDER BY started_at DESC LIMIT 1",
        )?;
        let mut rows = stmt.query_map([], |r| {
            Ok(OpenSegment {
                started_at: r.get(0)?,
                day: r.get(1)?,
                sitting_ms: r.get(2)?,
                updated_at: r.get(3)?,
            })
        })?;
        rows.next().transpose()
    }

    /// 把残留的未闭合段统一收口。reason 由调用方给：离开太久记 exit，异常退出记 stale
    pub fn close_open(&self, reason: &str) -> SqlResult<usize> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE segment SET closed = 1, end_reason = ?1 WHERE closed = 0",
            params![reason],
        )
    }

    /// 当日各段明细，新的在前
    pub fn segments(&self, day: &str, limit: u32) -> SqlResult<Vec<SegmentRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT started_at, sitting_ms, closed, end_reason FROM segment
             WHERE day = ?1 ORDER BY started_at DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![day, limit], |r| {
                Ok(SegmentRow {
                    started_at: r.get(0)?,
                    sitting_ms: r.get(1)?,
                    closed: r.get::<_, i32>(2)? == 1,
                    end_reason: r.get(3)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn today(&self, day: &str) -> SqlResult<Today> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"SELECT COALESCE(SUM(sitting_ms),0), COALESCE(MAX(continuous_ms),0), COUNT(*)
               FROM segment WHERE day = ?1"#,
        )?;
        let (sitting_ms, longest_ms, segments) =
            stmt.query_row(params![day], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        let reminders = conn.query_row(
            "SELECT COUNT(*) FROM reminder WHERE day = ?1",
            params![day],
            |r| r.get(0),
        )?;
        Ok(Today {
            day: day.to_string(),
            sitting_ms,
            longest_ms,
            segments,
            reminders,
        })
    }

    /// 记一次真实提醒；style 是当时的窗口形态，预览不写，避免污染统计
    pub fn log_reminder(&self, day: &str, kind: &str, at_iso: &str, style: u8) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO reminder (day, kind, at, style) VALUES (?1, ?2, ?3, ?4)",
            params![day, kind, at_iso, style as i64],
        )?;
        Ok(())
    }

    /// 近 N 天提醒明细，供诊断导出
    pub fn reminder_recent(&self, days: u32) -> SqlResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let since = (chrono::Local::now().date_naive()
            - chrono::Duration::days(days.max(1) as i64 - 1))
            .format("%Y-%m-%d")
            .to_string();
        let mut stmt = conn.prepare(
            "SELECT day, at, kind, style FROM reminder WHERE day >= ?1 ORDER BY id DESC LIMIT 200",
        )?;
        let rows = stmt
            .query_map(params![since], |r| {
                Ok(format!(
                    "{} {} kind={} style={}",
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })?
            .collect::<SqlResult<Vec<_>>>()?;
        Ok(rows)
    }

    /// 每天的提醒次数，供 CSV 导出使用
    pub fn reminder_by_day(&self) -> SqlResult<std::collections::HashMap<String, i64>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT day, COUNT(*) FROM reminder GROUP BY day")?;
        let map = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
            .collect::<SqlResult<std::collections::HashMap<_, _>>>()?;
        Ok(map)
    }

    /// 清空全部记录：段、提醒次数都删，配置保留
    pub fn clear_records(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("DELETE FROM segment; DELETE FROM reminder;")?;
        Ok(())
    }

    /// 导出用：全部每日汇总（不限天数）
    pub fn all_days(&self) -> SqlResult<Vec<DayRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"SELECT day, SUM(sitting_ms), MAX(continuous_ms)
               FROM segment GROUP BY day ORDER BY day ASC"#,
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(DayRow {
                    day: r.get(0)?,
                    sitting_ms: r.get(1)?,
                    longest_ms: r.get(2)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;
        Ok(rows)
    }

    /// 导出用：全部段明细，按时间升序
    pub fn all_segments(&self) -> SqlResult<Vec<SegmentFull>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT started_at, day, sitting_ms, continuous_ms, closed, end_reason FROM segment
             ORDER BY started_at ASC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(SegmentFull {
                    started_at: r.get(0)?,
                    day: r.get(1)?,
                    sitting_ms: r.get(2)?,
                    continuous_ms: r.get(3)?,
                    closed: r.get::<_, i32>(4)? == 1,
                    end_reason: r.get(5)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;
        Ok(rows)
    }

    /// 自 since_day（含）起的每日聚合，按日期升序。
    /// reminder 先按天聚合成子查询再 LEFT JOIN，避免一对多把 SUM 放大。
    /// 「起身次数」只统计真正站起来的结束原因：跨零点与退出结算不算。
    pub fn trend(&self, since_day: &str) -> SqlResult<Vec<TrendRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"SELECT s.day,
                      SUM(s.sitting_ms),
                      MAX(s.continuous_ms),
                      COUNT(*),
                      SUM(CASE WHEN s.closed = 1
                               AND s.end_reason IN ('away','dismiss','unknown')
                          THEN 1 ELSE 0 END),
                      COALESCE(r.cnt, 0)
               FROM segment s
               LEFT JOIN (SELECT day, COUNT(*) AS cnt FROM reminder GROUP BY day) r
                      ON r.day = s.day
               WHERE s.day >= ?1
               GROUP BY s.day ORDER BY s.day ASC"#,
        )?;
        let rows = stmt
            .query_map(params![since_day], |r| {
                Ok(TrendRow {
                    day: r.get(0)?,
                    sitting_ms: r.get(1)?,
                    longest_ms: r.get(2)?,
                    segments: r.get(3)?,
                    rises: r.get(4)?,
                    reminders: r.get(5)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;
        Ok(rows)
    }

    /// 按时段（0..23 时）聚合坐姿时长，供历史页热力条使用。
    /// 一段跨小时时必须拆开算，否则 09:55–10:40 会整段落到 9 点，10 点变成空白。
    /// 区间是左闭右开的 `[since, before)`：热力条和其它统计一样只用走完的日子，
    /// 把今天排掉，否则「最近 N 天」里今天那格会随着今天推进不断变深。
    pub fn hourly(&self, since_day: &str, before_day: &str) -> SqlResult<Vec<i64>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT started_at, sitting_ms FROM segment WHERE day >= ?1 AND day < ?2",
        )?;
        let mut out = [0i64; 24];
        let rows = stmt.query_map(params![since_day, before_day], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (started_at, ms) = row?;
            spread(start_of_day_ms(&started_at), ms, &mut out);
        }
        Ok(out.to_vec())
    }
}

/// `YYYY-MM-DDTHH:MM:SS` → 当天零时起的毫秒偏移（解析失败按 0 点算）
fn start_of_day_ms(iso: &str) -> i64 {
    let part = |a: usize, b: usize| {
        iso.get(a..b)
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0)
    };
    (part(11, 13) * 3600 + part(14, 16) * 60 + part(17, 19)) * 1000
}

/// 把一段时长从起点开始按小时切开，逐小时累加
fn spread(start_ms: i64, dur_ms: i64, out: &mut [i64; 24]) {
    const HOUR: i64 = 3_600_000;
    let mut left = dur_ms.max(0);
    let mut pos = start_ms.clamp(0, 24 * HOUR);
    while left > 0 && pos < 24 * HOUR {
        let hour = (pos / HOUR) as usize;
        let end = (hour as i64 + 1) * HOUR;
        let take = left.min(end - pos);
        out[hour] += take;
        left -= take;
        pos = end;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        Db::in_memory().unwrap()
    }

    #[test]
    fn reminder_records_style_and_migrates_legacy_table() {
        let db = db();
        db.log_reminder("2026-11-06", "light", "2026-11-06T10:00:00", 2).unwrap();
        let rows = db.reminder_recent(7).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].contains("style=2"), "应记录提醒窗口形态: {}", rows[0]);
    }

    #[test]
    fn migrate_adds_columns_and_tags_legacy_rows() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE reminder (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT, kind TEXT, at TEXT);
             CREATE TABLE segment (
                 started_at TEXT PRIMARY KEY, day TEXT NOT NULL, sitting_ms INTEGER NOT NULL,
                 continuous_ms INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
             INSERT INTO segment VALUES ('2026-11-01T09:00:00','2026-11-01',600000,600000,1,'t');
             INSERT INTO segment VALUES ('2026-11-02T09:00:00','2026-11-02',600000,600000,0,'t');
             INSERT INTO segment VALUES ('2026-11-01T23:55:00','2026-11-01',300000,300000,1,'t');
             INSERT INTO segment VALUES ('2026-11-01T10:00:00','2026-11-01',60000,60000,1,'t');",
        ).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(user_version(&conn).unwrap(), SCHEMA_VERSION);

        let legacy = Db { conn: Mutex::new(conn) };
        legacy.log_reminder("2026-11-06", "alert", "2026-11-06T11:00:00", 0).unwrap();
        assert_eq!(legacy.reminder_recent(7).unwrap().len(), 1, "旧表补齐列后仍可写入");

        // 已闭合的普通老段记 unknown（历史口径），未闭合的记 open，
        // 零点结算的记 midnight，一分钟上下的残段记 stale
        let rows = legacy.segments("2026-11-01", 5).unwrap();
        let by_start = |s: &str| rows.iter().find(|r| r.started_at == s).cloned().unwrap();
        assert_eq!(by_start("2026-11-01T09:00:00").end_reason, "unknown");
        assert_eq!(by_start("2026-11-01T23:55:00").end_reason, "midnight");
        assert_eq!(by_start("2026-11-01T10:00:00").end_reason, "stale");
        let rows = legacy.segments("2026-11-02", 5).unwrap();
        assert_eq!(rows[0].end_reason, "open");
        // 重复迁移应当安全
        let conn = legacy.conn.lock().unwrap();
        migrate(&conn).unwrap();
    }

    #[test]
    fn upsert_is_idempotent_on_same_segment() {
        let db = db();
        db.save_segment("2026-11-04T09:00:00", "2026-11-04", 60_000, 60_000, false, "open", "t1")
            .unwrap();
        db.save_segment("2026-11-04T09:00:00", "2026-11-04", 120_000, 120_000, false, "open", "t2")
            .unwrap();

        let t = db.today("2026-11-04").unwrap();
        assert_eq!(t.segments, 1, "同一段反复 UPSERT 只应留一行");
        assert_eq!(t.sitting_ms, 120_000);
        assert_eq!(t.longest_ms, 120_000);
    }

    #[test]
    fn multiple_segments_aggregate() {
        let db = db();
        db.save_segment("A", "2026-11-04", 600_000, 600_000, true, "away", "t").unwrap();
        db.save_segment("B", "2026-11-04", 300_000, 300_000, false, "open", "t").unwrap();
        db.save_segment("C", "2026-11-03", 500_000, 200_000, true, "dismiss", "t").unwrap();

        let t = db.today("2026-11-04").unwrap();
        assert_eq!(t.segments, 2);
        assert_eq!(t.sitting_ms, 900_000);
        assert_eq!(t.longest_ms, 600_000);

        let trend = db.trend("2026-11-01").unwrap();
        assert_eq!(trend.len(), 2, "两天的数据应聚合成两行");
        assert_eq!(trend[0].day, "2026-11-03");
        assert_eq!(trend[1].sitting_ms, 900_000);
    }

    #[test]
    fn rises_exclude_midnight_and_exit() {
        let db = db();
        db.save_segment("A", "2026-11-04", 600_000, 600_000, true, "away", "t").unwrap();
        db.save_segment("B", "2026-11-04", 600_000, 600_000, true, "dismiss", "t").unwrap();
        db.save_segment("C", "2026-11-04", 600_000, 600_000, true, "midnight", "t").unwrap();
        db.save_segment("D", "2026-11-04", 600_000, 600_000, true, "exit", "t").unwrap();
        db.save_segment("E", "2026-11-04", 600_000, 600_000, false, "open", "t").unwrap();

        let trend = db.trend("2026-11-01").unwrap();
        assert_eq!(trend[0].segments, 5);
        assert_eq!(trend[0].rises, 2, "只有离座与主动起身算起身");
    }

    #[test]
    fn hourly_splits_segment_across_hours() {
        let db = db();
        // 09:50 坐 30 分钟：10 分钟落在 9 点，20 分钟落在 10 点
        db.save_segment("2026-11-04T09:50:00", "2026-11-04", 1_800_000, 1_800_000, true, "away", "t")
            .unwrap();
        let h = db.hourly("2026-11-01", "2026-11-05").unwrap();
        assert_eq!(h[9], 600_000, "9 点只剩 10 分钟");
        assert_eq!(h[10], 1_200_000, "10 点接住 20 分钟");
        assert_eq!(h.iter().sum::<i64>(), 1_800_000, "拆分不应丢时长");
    }

    #[test]
    fn hourly_excludes_unfinished_today() {
        let db = db();
        db.save_segment("2026-11-04T09:50:00", "2026-11-04", 1_800_000, 1_800_000, true, "away", "t")
            .unwrap();
        db.save_segment("2026-11-05T09:10:00", "2026-11-05", 600_000, 600_000, false, "open", "t")
            .unwrap();
        // 上界是今天：今天那条不该进来，否则「最近 N 天」会随今天推进不停变深
        let h = db.hourly("2026-11-01", "2026-11-05").unwrap();
        assert_eq!(h[9], 600_000, "只有 4 号那 10 分钟");
        assert_eq!(h.iter().sum::<i64>(), 1_800_000);
    }

    #[test]
    fn millisecond_keys_keep_two_segments_within_one_second() {
        let db = db();
        // 同一秒内「结束旧段 + 开始新段」在秒级主键下会互相覆盖，掉一段时长
        db.save_segment("2026-11-04T09:00:00.120", "2026-11-04", 40_000, 40_000, true, "away", "t")
            .unwrap();
        db.save_segment("2026-11-04T09:00:00.480", "2026-11-04", 20_000, 20_000, false, "open", "t")
            .unwrap();
        let all = db.segments("2026-11-04", 10).unwrap();
        assert_eq!(all.len(), 2, "毫秒级主键应保留两段，实际 {}", all.len());
        assert_eq!(
            all.iter().map(|s| s.sitting_ms).sum::<i64>(),
            60_000,
            "两段时长都不该丢"
        );
    }

    #[test]
    fn legacy_second_precision_rows_still_parse() {
        // 老库里的起点没有毫秒，迁移与统计都不能因此算错
        assert!(parse_at("2026-11-04T09:00:00").is_some());
        assert!(parse_at("2026-11-04T09:00:00.123").is_some());
        assert!(parse_at("2026-11-04T09:00:00.123456").is_some());
        assert!(ends_at_midnight("2026-11-04T23:58:00", 120_000), "跨零点应识别出来");
        assert!(!ends_at_midnight("2026-11-04T09:00:00", 600_000));
    }

    #[test]
    fn open_segment_roundtrip() {
        let db = db();
        db.save_segment("2026-11-04T09:00:00", "2026-11-04", 600_000, 600_000, false, "open", "2026-11-04T09:10:00")
            .unwrap();
        db.save_segment("2026-11-04T11:00:00", "2026-11-04", 300_000, 300_000, true, "away", "2026-11-04T11:05:00")
            .unwrap();
        let open = db.open_segment().unwrap().expect("应能读到未闭合段");
        assert_eq!(open.started_at, "2026-11-04T09:00:00");
        assert_eq!(open.sitting_ms, 600_000);
        assert_eq!(open.updated_at, "2026-11-04T09:10:00");

        assert_eq!(db.close_open("exit").unwrap(), 1);
        assert!(db.open_segment().unwrap().is_none(), "收口后不该还有未闭合段");
    }

    #[test]
    fn settings_roundtrip() {
        let db = db();
        db.set_setting("alert_min", "90").unwrap();
        db.set_setting("alert_min", "100").unwrap();
        assert_eq!(db.settings().unwrap().get("alert_min").unwrap(), "100");
    }

    #[test]
    fn empty_day_returns_zero() {
        let db = db();
        let t = db.today("2026-11-04").unwrap();
        assert_eq!(t.sitting_ms, 0);
        assert_eq!(t.segments, 0);
    }
}

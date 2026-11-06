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
}

/// 导出用的完整段明细
#[derive(Debug, Clone, Serialize)]
pub struct SegmentFull {
    pub started_at: String,
    pub day: String,
    pub sitting_ms: i64,
    pub continuous_ms: i64,
    pub closed: bool,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct DayRow {
    pub day: String,
    pub sitting_ms: i64,
    pub longest_ms: i64,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS segment (
    started_at    TEXT PRIMARY KEY,
    day           TEXT NOT NULL,
    sitting_ms    INTEGER NOT NULL,
    continuous_ms INTEGER NOT NULL,
    closed        INTEGER NOT NULL DEFAULT 0,
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
    at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminder_day ON reminder(day);
"#;

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
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// 快照写入；段结束时把 closed 置 1
    pub fn save_segment(
        &self,
        started_at: &str,
        day: &str,
        sitting_ms: i64,
        continuous_ms: i64,
        closed: bool,
        now_iso: &str,
    ) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO segment (started_at, day, sitting_ms, continuous_ms, closed, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(started_at) DO UPDATE SET
                sitting_ms    = excluded.sitting_ms,
                continuous_ms = excluded.continuous_ms,
                closed        = excluded.closed,
                updated_at    = excluded.updated_at
            "#,
            params![started_at, day, sitting_ms, continuous_ms, closed as i32, now_iso],
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

    /// 上次进程异常退出会留下未闭合的段，启动时统一收口
    pub fn close_stale(&self) -> SqlResult<usize> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE segment SET closed = 1 WHERE closed = 0", [])
    }

    /// 当日各段明细，新的在前
    pub fn segments(&self, day: &str, limit: u32) -> SqlResult<Vec<SegmentRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT started_at, sitting_ms, closed FROM segment
             WHERE day = ?1 ORDER BY started_at DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![day, limit], |r| {
                Ok(SegmentRow {
                    started_at: r.get(0)?,
                    sitting_ms: r.get(1)?,
                    closed: r.get::<_, i32>(2)? == 1,
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

    /// 记一次真实提醒；预览不写，避免污染统计
    pub fn log_reminder(&self, day: &str, kind: &str, at_iso: &str) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO reminder (day, kind, at) VALUES (?1, ?2, ?3)",
            params![day, kind, at_iso],
        )?;
        Ok(())
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
            "SELECT started_at, day, sitting_ms, continuous_ms, closed FROM segment
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
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;
        Ok(rows)
    }

    /// 自 since_day（含）起的每日聚合，按日期升序
    pub fn trend(&self, since_day: &str) -> SqlResult<Vec<DayRow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"SELECT day, SUM(sitting_ms), MAX(continuous_ms)
               FROM segment WHERE day >= ?1
               GROUP BY day ORDER BY day ASC"#,
        )?;
        let rows = stmt
            .query_map(params![since_day], |r| {
                Ok(DayRow {
                    day: r.get(0)?,
                    sitting_ms: r.get(1)?,
                    longest_ms: r.get(2)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Db {
        Db::in_memory().unwrap()
    }

    #[test]
    fn upsert_is_idempotent_on_same_segment() {
        let db = db();
        db.save_segment("2026-11-04T09:00:00", "2026-11-04", 60_000, 60_000, false, "t1")
            .unwrap();
        db.save_segment("2026-11-04T09:00:00", "2026-11-04", 120_000, 120_000, false, "t2")
            .unwrap();

        let t = db.today("2026-11-04").unwrap();
        assert_eq!(t.segments, 1, "同一段反复 UPSERT 只应留一行");
        assert_eq!(t.sitting_ms, 120_000);
        assert_eq!(t.longest_ms, 120_000);
    }

    #[test]
    fn multiple_segments_aggregate() {
        let db = db();
        db.save_segment("A", "2026-11-04", 600_000, 600_000, true, "t").unwrap();
        db.save_segment("B", "2026-11-04", 300_000, 300_000, false, "t").unwrap();
        db.save_segment("C", "2026-11-03", 500_000, 200_000, true, "t").unwrap();

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

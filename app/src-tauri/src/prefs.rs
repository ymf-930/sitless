//! 用户偏好：目标、工作日、免打扰时段、提醒呈现与音效
//!
//! 全部存在 `setting` 表里，运行时每 tick 读一次，改完立即生效。

use chrono::{Datelike, Local, Timelike};

use crate::db::Db;

pub const KEY_DAILY_GOAL: &str = "daily_goal";
pub const KEY_WORKDAYS: &str = "workdays";
pub const KEY_QUIET: &str = "quiet";
pub const KEY_CONFIRM: &str = "confirm_before_rest";
pub const KEY_ALERT_SECONDS: &str = "alert_seconds";
pub const KEY_STYLE: &str = "reminder_style";
pub const KEY_ACTION_BEEP: &str = "action_beep";
pub const KEY_TONE: &str = "tone";
pub const KEY_SOUND_ON: &str = "sound_on";
pub const KEY_VOLUME: &str = "volume";
pub const KEY_LANGUAGE: &str = "language";
pub const KEY_FULLSCREEN_SUPPRESS: &str = "fullscreen_suppress";

/// bit0=周一 … bit6=周日
fn weekday_bit(now: chrono::DateTime<Local>) -> u8 {
    1 << now.weekday().num_days_from_monday()
}

fn parse_hhmm(s: &str) -> Option<u16> {
    let mut it = s.trim().split(':');
    let h: u16 = it.next()?.parse().ok()?;
    let m: u16 = it.next()?.parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some(h * 60 + m)
}

pub fn fmt_hhmm(m: u16) -> String {
    format!("{:02}:{:02}", m / 60, m % 60)
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct Preferences {
    pub daily_goal: u32,
    pub workdays: u8,
    pub quiet: Vec<(u16, u16)>,
    pub confirm_before_rest: bool,
    /// 警戒窗强制等待秒数，0 表示不锁
    pub alert_seconds: u32,
    pub reminder_style: u8,
    pub action_beep: bool,
    pub tone: u8,
    pub sound_on: bool,
    pub volume: u8,
    /// auto = 跟随系统，zh / en 为手动指定
    pub language: String,
    pub fullscreen_suppress: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            daily_goal: 8,
            workdays: 0b0011_1111, // bit0~bit5：周一到周六
            quiet: vec![(12 * 60, 13 * 60 + 30)],
            confirm_before_rest: true,
            alert_seconds: 10,
            reminder_style: 0,
            action_beep: false,
            tone: 2,
            sound_on: true,
            volume: 62,
            language: "auto".into(),
            fullscreen_suppress: true,
        }
    }
}

impl Preferences {
    pub fn from_db(db: &Db) -> Self {
        let mut p = Self::default();
        let Ok(map) = db.settings() else {
            return p;
        };
        if let Some(v) = map.get(KEY_DAILY_GOAL).and_then(|s| s.parse::<u32>().ok()) {
            p.daily_goal = v.clamp(1, 30);
        }
        if let Some(v) = map.get(KEY_WORKDAYS).and_then(|s| s.parse::<u8>().ok()) {
            p.workdays = v & 0x7f;
        }
        if let Some(v) = map.get(KEY_QUIET) {
            p.quiet = parse_quiet(v);
        }
        if let Some(v) = map.get(KEY_CONFIRM) {
            p.confirm_before_rest = v == "1";
        }
        if let Some(v) = map.get(KEY_ALERT_SECONDS).and_then(|s| s.parse::<u32>().ok()) {
            p.alert_seconds = v.min(120);
        }
        if let Some(v) = map.get(KEY_STYLE).and_then(|s| s.parse::<u8>().ok()) {
            p.reminder_style = v.min(2);
        }
        if let Some(v) = map.get(KEY_ACTION_BEEP) {
            p.action_beep = v == "1";
        }
        if let Some(v) = map.get(KEY_TONE).and_then(|s| s.parse::<u8>().ok()) {
            p.tone = v.min(4);
        }
        if let Some(v) = map.get(KEY_SOUND_ON) {
            p.sound_on = v == "1";
        }
        if let Some(v) = map.get(KEY_VOLUME).and_then(|s| s.parse::<u32>().ok()) {
            p.volume = v.min(100) as u8;
        }
        if let Some(v) = map.get(KEY_LANGUAGE) {
            if matches!(v.as_str(), "auto" | "zh" | "en") {
                p.language = v.clone();
            }
        }
        if let Some(v) = map.get(KEY_FULLSCREEN_SUPPRESS) {
            p.fullscreen_suppress = v == "1";
        }
        p
    }

    /// 校验并修改一项；返回错误时调用方不应落库
    pub fn set(&mut self, key: &str, raw: &str) -> Result<(), String> {
        match key {
            KEY_DAILY_GOAL => {
                let v: u32 = raw.parse().map_err(|_| "目标必须是数字")?;
                self.daily_goal = v.clamp(1, 30);
            }
            KEY_WORKDAYS => {
                let v: u8 = raw.parse().map_err(|_| "工作日必须是数字")?;
                self.workdays = v & 0x7f;
            }
            KEY_QUIET => {
                self.quiet = parse_quiet(raw);
                if raw.trim() != format_quiet(&self.quiet) && !raw.trim().is_empty() {
                    // 允许非法片段被丢弃，但至少要有合法项
                    if self.quiet.is_empty() {
                        return Err("时间格式应为 HH:MM-HH:MM".into());
                    }
                }
            }
            KEY_CONFIRM | KEY_ACTION_BEEP | KEY_SOUND_ON => {
                let on = raw == "1" || raw == "true";
                match key {
                    KEY_CONFIRM => self.confirm_before_rest = on,
                    KEY_ACTION_BEEP => self.action_beep = on,
                    _ => self.sound_on = on,
                }
            }
            KEY_ALERT_SECONDS => {
                let v: u32 = raw.parse().map_err(|_| "秒数必须是数字")?;
                self.alert_seconds = v.min(120);
            }
            KEY_STYLE => {
                let v: u8 = raw.parse().map_err(|_| "窗口形态必须是数字")?;
                self.reminder_style = v.min(2);
            }
            KEY_TONE => {
                let v: u8 = raw.parse().map_err(|_| "音效必须是数字")?;
                self.tone = v.min(4);
            }
            KEY_VOLUME => {
                let v: u32 = raw.parse().map_err(|_| "音量必须是数字")?;
                self.volume = v.min(100) as u8;
            }
            KEY_LANGUAGE => {
                if !matches!(raw, "auto" | "zh" | "en") {
                    return Err("语言只支持 auto / zh / en".into());
                }
                self.language = raw.to_string();
            }
            KEY_FULLSCREEN_SUPPRESS => {
                self.fullscreen_suppress = raw == "1" || raw == "true";
            }
            _ => return Err(format!("未知配置项: {key}")),
        }
        Ok(())
    }

    pub fn persist(&self, db: &Db) {
        let pairs: Vec<(&str, String)> = vec![
            (KEY_DAILY_GOAL, self.daily_goal.to_string()),
            (KEY_WORKDAYS, self.workdays.to_string()),
            (KEY_QUIET, format_quiet(&self.quiet)),
            (KEY_CONFIRM, (self.confirm_before_rest as u8).to_string()),
            (KEY_ALERT_SECONDS, self.alert_seconds.to_string()),
            (KEY_STYLE, self.reminder_style.to_string()),
            (KEY_ACTION_BEEP, (self.action_beep as u8).to_string()),
            (KEY_TONE, self.tone.to_string()),
            (KEY_SOUND_ON, (self.sound_on as u8).to_string()),
            (KEY_VOLUME, self.volume.to_string()),
            (KEY_LANGUAGE, self.language.clone()),
            (KEY_FULLSCREEN_SUPPRESS, (self.fullscreen_suppress as u8).to_string()),
        ];
        for (k, v) in pairs {
            if let Err(e) = db.set_setting(k, &v) {
                log::error!("保存偏好失败 {k}: {e}");
            }
        }
    }

    /// 当前是否处于「可以提醒」的时间（工作日 且 不在免打扰时段）
    pub fn active_now(&self) -> bool {
        let now = Local::now();
        if self.workdays & weekday_bit(now) == 0 {
            return false;
        }
        let minute = (now.hour() * 60 + now.minute()) as u16;
        !self.quiet.iter().any(|&(a, b)| minute >= a && minute < b)
    }

    pub fn quiet_labels(&self) -> Vec<String> {
        self.quiet
            .iter()
            .map(|&(a, b)| format!("{}-{}", fmt_hhmm(a), fmt_hhmm(b)))
            .collect()
    }
}

fn parse_quiet(s: &str) -> Vec<(u16, u16)> {
    s.split(',')
        .filter_map(|part| {
            let (a, b) = part.trim().split_once('-')?;
            let (start, end) = (parse_hhmm(a)?, parse_hhmm(b)?);
            if end <= start {
                return None;
            }
            Some((start, end))
        })
        .collect()
}

pub fn format_quiet(ranges: &[(u16, u16)]) -> String {
    ranges
        .iter()
        .map(|&(a, b)| format!("{}-{}", fmt_hhmm(a), fmt_hhmm(b)))
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_roundtrip() {
        let s = "12:00-13:00,18:30-19:15";
        let parsed = parse_quiet(s);
        assert_eq!(parsed.len(), 2);
        assert_eq!(format_quiet(&parsed), s);
    }

    #[test]
    fn invalid_quiet_is_dropped() {
        assert!(parse_quiet("25:00-26:00").is_empty());
        assert_eq!(parse_quiet("12:00-11:00").len(), 0);
    }

    #[test]
    fn set_clamps_values() {
        let mut p = Preferences::default();
        p.set(KEY_DAILY_GOAL, "999").unwrap();
        assert_eq!(p.daily_goal, 30);
        p.set(KEY_TONE, "7").unwrap();
        assert_eq!(p.tone, 4);
        p.set(KEY_VOLUME, "999").unwrap();
        assert_eq!(p.volume, 100);
        assert!(p.set("nope", "1").is_err());
    }

    #[test]
    fn active_now_respects_workday_mask() {
        let mut p = Preferences::default();
        p.quiet.clear();
        p.workdays = 0;
        assert!(!p.active_now(), "全不选时不应提醒");
        p.workdays = 0x7f;
        assert!(p.active_now(), "全选且无免打扰时应提醒");
    }
}

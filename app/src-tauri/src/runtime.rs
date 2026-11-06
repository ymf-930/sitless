//! 运行时：1 秒 tick 驱动状态机，把 Effect 落到托盘、通知与数据库
//!
//! 线程模型：单个后台线程独占 Timer；外部（托盘菜单、前端）通过 mpsc 投递事件。
//! 偏好（工作日/免打扰/音效/窗口形态）每秒读一次，改完下一 tick 生效。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use chrono::Local;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::db::{Db, DayRow, Today};
use crate::locale;
use crate::platform;
use crate::prefs::Preferences;
use crate::reminder;
use crate::sound;
use crate::state::{Config, Effect, Event, Ms, Timer, MIN};

pub const TRAY_ID: &str = "main";
const MAIN: &str = "main";

fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[derive(Clone, Debug)]
pub struct RuntimeConfig {
    pub state: Config,
    pub idle_threshold: Ms,
    pub prefs: Preferences,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            state: Config::default(),
            idle_threshold: 3 * MIN,
            prefs: Preferences::default(),
        }
    }
}

impl RuntimeConfig {
    pub fn from_db(db: &Db) -> Self {
        let mut rc = Self {
            prefs: Preferences::from_db(db),
            ..Default::default()
        };
        let Ok(map) = db.settings() else {
            return rc;
        };
        let num = |k: &str| map.get(k).and_then(|v| v.parse::<u64>().ok());
        if let Some(v) = num("alert_min") {
            rc.state.alert_threshold = v * MIN;
        }
        if let Some(v) = num("activity_min") {
            rc.state.activity_interval = v * MIN;
        }
        if let Some(v) = num("repeat_limit") {
            rc.state.repeat_limit = v.clamp(1, 6) as u8;
        }
        if let Some(v) = num("repeat_interval_min") {
            rc.state.repeat_interval = v.clamp(1, 30) * MIN;
        }
        if let Some(v) = num("idle_min") {
            rc.idle_threshold = v * MIN;
        }
        rc
    }

    /// 冒烟测试用：把时间尺度压到秒级
    fn with_env(&mut self) {
        if std::env::var("SITLESS_FAST").is_err() {
            return;
        }
        let alert_secs: Ms = std::env::var("SITLESS_ALERT_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(120);
        self.state.activity_interval = MIN;
        self.state.alert_threshold = alert_secs * 1000;
        self.state.repeat_interval = 10_000;
        self.state.quota_window = MIN;
        self.state.pause_default = MIN;
        self.idle_threshold = 8_000;
    }
}

pub struct Engine {
    tx: Sender<Event>,
    timer: Arc<Mutex<Timer>>,
    idle_ms: Arc<AtomicU64>,
    prefs: Arc<Mutex<Preferences>>,
    db: Arc<Db>,
}

impl Engine {
    pub fn send(&self, ev: Event) {
        let _ = self.tx.send(ev);
    }

    /// 退出前结算当前段，否则下次启动会多出一条没闭合的段
    pub fn finalize(&self) {
        let Some((sitting, continuous)) = self.timer.lock().unwrap().take_segment() else {
            return;
        };
        let now_wall = Local::now();
        let start_wall = now_wall - chrono::Duration::milliseconds(sitting as i64);
        let started_at = start_wall.format("%Y-%m-%dT%H:%M:%S").to_string();
        let day = start_wall.format("%Y-%m-%d").to_string();
        let now_iso = now_wall.format("%Y-%m-%dT%H:%M:%S").to_string();
        if let Err(e) = self.db.save_segment(
            &started_at,
            &day,
            sitting as i64,
            continuous as i64,
            true,
            &now_iso,
        ) {
            log::error!("退出结算失败: {e}");
        } else {
            log::info!("[退出结算] sitting={sitting}");
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        let t = self.timer.lock().unwrap();
        let p = self.prefs.lock().unwrap();
        Snapshot {
            idle_threshold_ms: self.idle_ms.load(Ordering::Relaxed),
            sitting_ms: t.sitting(),
            next_alert_ms: t.next_alert_in(),
            next_activity_ms: t.next_activity_in(),
            alert_threshold_ms: t.alert_threshold(),
            activity_interval_ms: t.activity_interval(),
            repeat_interval_ms: t.repeat_interval(),
            repeat_limit: t.repeat_limit(),
            paused: t.is_paused(),
            present: t.is_present(),
            daily_goal: p.daily_goal,
            workdays: p.workdays,
            quiet: p.quiet_labels(),
            confirm_before_rest: p.confirm_before_rest,
            alert_seconds: p.alert_seconds,
            reminder_style: p.reminder_style,
            action_beep: p.action_beep,
            tone: p.tone,
            sound_on: p.sound_on,
            volume: p.volume,
            language: p.language.clone(),
            fullscreen_suppress: p.fullscreen_suppress,
        }
    }
}

#[derive(serde::Serialize)]
pub struct Snapshot {
    pub idle_threshold_ms: Ms,
    pub sitting_ms: Ms,
    pub next_alert_ms: Ms,
    pub next_activity_ms: Ms,
    pub alert_threshold_ms: Ms,
    pub activity_interval_ms: Ms,
    pub repeat_interval_ms: Ms,
    pub repeat_limit: u8,
    pub paused: bool,
    pub present: bool,
    pub daily_goal: u32,
    pub workdays: u8,
    pub quiet: Vec<String>,
    pub confirm_before_rest: bool,
    pub alert_seconds: u32,
    pub reminder_style: u8,
    pub action_beep: bool,
    pub tone: u8,
    pub sound_on: bool,
    pub volume: u8,
    pub language: String,
    pub fullscreen_suppress: bool,
}

#[tauri::command]
pub fn status(engine: tauri::State<'_, Engine>) -> Snapshot {
    engine.snapshot()
}

/// 前端解析完 auto 后把实际语言同步给后端（系统通知、托盘、CSV 都要用）
#[tauri::command]
pub fn set_ui_language(lang: String) {
    locale::set(&lang);
}

#[tauri::command]
pub fn pause(engine: tauri::State<'_, Engine>, minutes: Option<u64>) {
    engine.send(Event::Pause {
        dur: Some(minutes.unwrap_or(15) * MIN),
    });
}

#[tauri::command]
pub fn resume(engine: tauri::State<'_, Engine>) {
    engine.send(Event::Resume);
}

#[tauri::command]
pub fn skip(engine: tauri::State<'_, Engine>, window: tauri::Window) {
    log::info!("cmd=skip from={}", window.label());
    engine.send(Event::SkipAny);
}

#[tauri::command]
pub fn dismiss(engine: tauri::State<'_, Engine>, window: tauri::Window) {
    log::info!("cmd=dismiss from={}", window.label());
    engine.send(Event::Dismiss);
}

/// 修改一项配置：校验 → 立即生效 → 落库 → 返回最新快照
#[tauri::command]
pub fn update_config(
    engine: tauri::State<'_, Engine>,
    key: String,
    value: String,
) -> Result<Snapshot, String> {
    let raw = value.trim();

    // 计时类：直接改 Timer / idle 阈值
    let (lo, hi) = match key.as_str() {
        "alert_min" => (30, 180),
        "activity_min" => (10, 120),
        "repeat_limit" => (1, 6),
        "repeat_interval_min" => (1, 30),
        "idle_min" => (1, 15),
        _ => (0, 0),
    };
    if hi > 0 {
        let n: u64 = raw.parse().map_err(|_| format!("{key} 需要数字"))?;
        let v = n.clamp(lo, hi);
        match key.as_str() {
            "idle_min" => engine.idle_ms.store(v * MIN, Ordering::Relaxed),
            "repeat_limit" => engine.timer.lock().unwrap().config.repeat_limit = v as u8,
            "repeat_interval_min" => engine.timer.lock().unwrap().config.repeat_interval = v * MIN,
            "alert_min" => engine.timer.lock().unwrap().config.alert_threshold = v * MIN,
            "activity_min" => engine.timer.lock().unwrap().config.activity_interval = v * MIN,
            _ => unreachable!(),
        }
        if let Err(e) = engine.db.set_setting(&key, &v.to_string()) {
            log::error!("保存配置失败: {e}");
        }
        return Ok(engine.snapshot());
    }

    // 偏好类：校验后整份落库
    {
        let mut p = engine.prefs.lock().unwrap();
        p.set(&key, raw)?;
        p.persist(&engine.db);
        if key == "volume" {
            if let Err(e) = sound::set_volume(p.volume) {
                log::warn!("刷新提示音音量失败: {e}");
            }
        }
    }
    Ok(engine.snapshot())
}

/// 开机自启状态（读系统项，不存自己的库）
#[tauri::command]
pub fn autostart_state(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, on: bool) -> Result<(), String> {
    let m = app.autolaunch();
    let r = if on { m.enable() } else { m.disable() };
    r.map_err(|e| e.to_string())
}

/// 预览：按当前配置真实触发一次提醒
#[tauri::command]
pub fn preview(app: AppHandle, engine: tauri::State<'_, Engine>, kind: String) {
    let p = engine.prefs.lock().unwrap().clone();
    if kind == "alert" {
        reminder::show_alert(&app);
    } else {
        light_reminder(&app, &p);
    }
    if p.sound_on {
        sound::play(p.tone);
    }
}

/// 试听某个音效
#[tauri::command]
pub fn preview_tone(tone: u8) {
    sound::play(tone);
}

#[tauri::command]
pub fn preview_alert(app: AppHandle) {
    reminder::show_alert(&app);
}

#[tauri::command]
pub fn today(db: tauri::State<'_, Arc<Db>>) -> Today {
    let day = Local::now().format("%Y-%m-%d").to_string();
    db.today(&day).unwrap_or(Today {
        day,
        ..Default::default()
    })
}

fn mins(ms: i64) -> String {
    format!("{:.1}", ms as f64 / 60_000.0)
}

fn cell(s: &str) -> String {
    if s.chars().any(|c| matches!(c, ',' | '"' | '\n' | '\r')) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// 导出 CSV 到「下载」目录：每日汇总 + 段明细，返回绝对路径
#[tauri::command]
pub fn export_csv(
    app: AppHandle,
    db: tauri::State<'_, Arc<Db>>,
) -> Result<String, String> {
    use std::collections::HashMap;

    let days = db.all_days().map_err(|e| e.to_string())?;
    let segs = db.all_segments().map_err(|e| e.to_string())?;
    let counts = db.reminder_by_day().map_err(|e| e.to_string())?;
    let mut per_day: HashMap<&str, i64> = HashMap::new();
    for s in &segs {
        *per_day.entry(s.day.as_str()).or_insert(0) += 1;
    }

    let en = locale::is_en();
    let mut out = String::from("\u{feff}"); // BOM，Excel 直接打开不乱码
    out.push_str(&format!(
        "{},{}\n\n",
        if en { "Exported at" } else { "导出时间" },
        Local::now().format("%Y-%m-%d %H:%M:%S")
    ));
    out.push_str(if en {
        "Daily summary\nDate,Sitting (min),Longest stretch (min),Segments,Reminders\n"
    } else {
        "每日汇总\n日期,坐姿总时长(分钟),最长连续(分钟),段数,提醒次数\n"
    });
    for d in &days {
        out.push_str(&format!(
            "{},{},{},{},{}\n",
            cell(&d.day),
            mins(d.sitting_ms),
            mins(d.longest_ms),
            per_day.get(d.day.as_str()).copied().unwrap_or(0),
            counts.get(&d.day).copied().unwrap_or(0),
        ));
    }
    out.push_str(if en {
        "\nSegments\nStarted,Date,Sitting (min),Continuous (min),Closed\n"
    } else {
        "\n段明细\n开始时间,日期,坐姿时长(分钟),连续时长(分钟),已结算\n"
    });
    for s in &segs {
        let closed = match (en, s.closed) {
            (true, true) => "Yes",
            (true, false) => "No",
            (false, true) => "是",
            (false, false) => "否",
        };
        out.push_str(&format!(
            "{},{},{},{},{}\n",
            cell(&s.started_at),
            cell(&s.day),
            mins(s.sitting_ms),
            mins(s.continuous_ms),
            closed,
        ));
    }

    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = Local::now().format("%Y%m%d-%H%M%S");
    let name = if locale::is_en() {
        format!("zouzou-records-{stamp}.csv")
    } else {
        format!("走走-记录-{stamp}.csv")
    };
    let path = dir.join(name);
    std::fs::write(&path, out).map_err(|e| e.to_string())?;
    log::info!("[导出] path={}", path.display());
    Ok(path.to_string_lossy().into_owned())
}

/// 在文件管理器里选中刚导出的文件
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let dir = std::path::Path::new(&path)
            .parent()
            .unwrap_or(std::path::Path::new("."));
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 清空全部记录（配置保留）：命令里先清库，运行时下一 tick 重置计时器并兜底再清一次
#[tauri::command]
pub fn clear_history(
    app: AppHandle,
    engine: tauri::State<'_, Engine>,
    db: tauri::State<'_, Arc<Db>>,
) -> Result<(), String> {
    db.clear_records().map_err(|e| e.to_string())?;
    engine.send(Event::ClearAll);
    let _ = app.emit("data://changed", ());
    log::info!("[清空] 已清空段与提醒记录");
    Ok(())
}

#[tauri::command]
pub fn segments(db: tauri::State<'_, Arc<Db>>) -> Vec<crate::db::SegmentRow> {
    let day = Local::now().format("%Y-%m-%d").to_string();
    db.segments(&day, 8).unwrap_or_default()
}

#[tauri::command]
pub fn trend(db: tauri::State<'_, Arc<Db>>, days: u32) -> Vec<DayRow> {
    let n = days.max(1) as i64;
    let since = (Local::now().date_naive() - chrono::Duration::days(n - 1))
        .format("%Y-%m-%d")
        .to_string();
    db.trend(&since).unwrap_or_default()
}

#[tauri::command]
pub fn diag(msg: String) {
    log::info!("[ui] {msg}");
}

pub fn spawn(app: AppHandle, mut rc: RuntimeConfig, db: Arc<Db>) -> Engine {
    rc.with_env();
    let (tx, rx) = mpsc::channel::<Event>();
    let timer = Arc::new(Mutex::new(Timer::new(0, rc.state)));
    let shared = Arc::clone(&timer);

    let idle_shared = Arc::new(AtomicU64::new(rc.idle_threshold));
    let idle_in_thread = Arc::clone(&idle_shared);
    let prefs_shared = Arc::new(Mutex::new(rc.prefs));
    let prefs_in_thread = Arc::clone(&prefs_shared);
    let db_in_thread = Arc::clone(&db);
    let fast = std::env::var("SITLESS_FAST").is_ok();
    let ignore_idle = std::env::var("SITLESS_IGNORE_IDLE").is_ok();

    thread::spawn(move || {
        let start = Instant::now();
        let mut last_date = Local::now().date_naive();
        let mut present = true;
        let mut suppressed = false;

        loop {
            thread::sleep(Duration::from_secs(1));
            let now = start.elapsed().as_millis() as Ms;
            let mut fx: Vec<Effect> = Vec::new();

            while let Ok(ev) = rx.try_recv() {
                match ev {
                    Event::ClearAll => {
                        // 本轮尚未落库的段写入一并丢弃，避免清空后旧数据又被写回来
                        fx.clear();
                        shared.lock().unwrap().reset_all();
                        if let Err(e) = db_in_thread.clear_records() {
                            log::error!("清空记录失败: {e}");
                        }
                        let _ = app.emit("data://changed", ());
                    }
                    other => fx.extend(shared.lock().unwrap().apply(other)),
                }
            }

            let today = Local::now().date_naive();
            if today != last_date {
                last_date = today;
                fx.extend(shared.lock().unwrap().apply(Event::Midnight));
            }

            let now_present = if ignore_idle {
                true
            } else {
                platform::idle_ms()
                    .map(|idle| idle < idle_in_thread.load(Ordering::Relaxed))
                    .unwrap_or(true)
            };
            if now_present != present {
                present = now_present;
                let p = prefs_in_thread.lock().unwrap();
                if p.action_beep {
                    sound::play(p.tone);
                }
                drop(p);
                fx.extend(
                    shared
                        .lock()
                        .unwrap()
                        .apply(Event::Presence { present }),
                );
            }

            // 「全屏时抑制提醒」可在设置页关闭；关掉时强制回到非抑制态
            let check_fullscreen = prefs_in_thread.lock().unwrap().fullscreen_suppress;
            let want = if check_fullscreen {
                platform::should_suppress().unwrap_or(false)
            } else {
                false
            };
            if want != suppressed {
                suppressed = want;
                fx.extend(
                    shared
                        .lock()
                        .unwrap()
                        .apply(Event::Fullscreen { on: want }),
                );
            }

            fx.extend(shared.lock().unwrap().apply(Event::Tick { now }));

            dispatch(
                &app,
                &shared,
                fx,
                now,
                fast,
                &db_in_thread,
                &prefs_in_thread,
            );
        }
    });

    Engine {
        tx,
        timer,
        idle_ms: idle_shared,
        prefs: prefs_shared,
        db,
    }
}

/// 单调时间换算成墙钟后落库
fn persist(db: &Db, now_ms: Ms, start_ms: Ms, sitting: Ms, continuous: Ms, closed: bool) {
    let now_wall = Local::now();
    let start_wall =
        now_wall - chrono::Duration::milliseconds(now_ms.saturating_sub(start_ms) as i64);
    let started_at = start_wall.format("%Y-%m-%dT%H:%M:%S").to_string();
    let day = start_wall.format("%Y-%m-%d").to_string();
    let now_iso = now_wall.format("%Y-%m-%dT%H:%M:%S").to_string();
    if let Err(e) = db.save_segment(
        &started_at,
        &day,
        sitting as i64,
        continuous as i64,
        closed,
        &now_iso,
    ) {
        log::error!("落库失败: {e}");
    }
}

/// 按窗口形态发一次轻提醒
fn light_reminder(app: &AppHandle, p: &Preferences) {
    let title = locale::t("该起身活动一下了");
    let body = locale::t("站起来走 1 分钟。");
    match p.reminder_style {
        1 => {
            show_main(app);
            let _ = app.emit("reminder://toast", &title);
        }
        2 => reminder::show_alert(app),
        _ => reminder::toast(app, &title, &body),
    }
}

/// 记一次真实提醒，供「提醒次数」与 CSV 导出使用；预览不计数
fn count_reminder(db: &Arc<Db>, kind: &str) {
    let now = Local::now();
    let day = now.format("%Y-%m-%d").to_string();
    let at = now.format("%Y-%m-%dT%H:%M:%S").to_string();
    if let Err(e) = db.log_reminder(&day, kind, &at) {
        log::error!("提醒次数落库失败: {e}");
    }
}

fn dispatch(
    app: &AppHandle,
    timer: &Arc<Mutex<Timer>>,
    fx: Vec<Effect>,
    now_ms: Ms,
    fast: bool,
    db: &Arc<Db>,
    prefs: &Arc<Mutex<Preferences>>,
) {
    let p = prefs.lock().unwrap().clone();
    let active = p.active_now();

    for e in fx {
        match e {
            Effect::Toast { at } => {
                if !active {
                    log::info!("[抑制][轻] 非工作日或免打扰 at={at}");
                    continue;
                }
                log::info!("[提醒][轻] at={at}");
                light_reminder(app, &p);
                count_reminder(db, "light");
                if p.sound_on {
                    sound::play(p.tone);
                }
            }
            Effect::Modal { at } => {
                if !active {
                    log::info!("[抑制][警戒] 非工作日或免打扰 at={at}");
                    continue;
                }
                log::info!("[提醒][警戒] at={at}");
                reminder::show_alert(app);
                count_reminder(db, "alert");
                if p.sound_on {
                    sound::play(p.tone);
                }
            }
            Effect::Summary { count, at } => {
                if !active {
                    continue;
                }
                log::info!("[汇总] 全屏期间抑制 {count} 次 at={at}");
                reminder::toast(
                    app,
                    &locale::t("刚才全屏期间有几次提醒"),
                    &if locale::is_en() {
                        format!("{count} reminders. Take a short walk when you can.")
                    } else {
                        format!("共 {count} 次。现在方便的话，起来走走。")
                    },
                );
            }
            Effect::UpsertSegment { start, sitting } => {
                if fast {
                    log::debug!("[快照] start={start} sitting={sitting}");
                }
                persist(db, now_ms, start, sitting, sitting, false);
            }
            Effect::CloseSegment {
                start,
                sitting,
                continuous,
            } => {
                log::info!("[结算] start={start} sitting={sitting} continuous={continuous}");
                persist(db, now_ms, start, sitting, continuous, true);
            }
            Effect::RolloverDay { at } => log::info!("[跨零点] at={at}"),
        }
    }

    let (paused, next) = {
        let t = timer.lock().unwrap();
        (t.is_paused(), t.next_alert_in())
    };
    let text = if paused {
        locale::t("走走 · 已暂停")
    } else if !active {
        locale::t("走走 · 休息中")
    } else if locale::is_en() {
        format!("Zouzou · alert in {} min", next / MIN)
    } else {
        format!("走走 · 距警戒 {} 分钟", next / MIN)
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(text));
    }
}

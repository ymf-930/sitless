mod db;
mod locale;
mod platform;
mod prefs;
mod reminder;
mod sound;
mod runtime;
mod state;

use tauri::{
    Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, WindowEvent,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use runtime::{Engine, RuntimeConfig, TRAY_ID};
use state::{Event, MIN};

const MAIN: &str = "main";
const TRAY_MENU: &str = "tray-menu";
const PAUSE_DURATION: u64 = 15 * MIN;

static TRAY_MENU_SHOWN: std::sync::OnceLock<std::sync::Mutex<std::time::Instant>> =
    std::sync::OnceLock::new();

fn mark_menu_shown() {
    let slot = TRAY_MENU_SHOWN.get_or_init(|| {
        std::sync::Mutex::new(std::time::Instant::now() - std::time::Duration::from_secs(10))
    });
    if let Ok(mut t) = slot.lock() {
        *t = std::time::Instant::now();
    }
}

/// 弹出瞬间的焦点抖动不算「点到别处」，600ms 内不收起菜单
fn menu_shown_recently() -> bool {
    TRAY_MENU_SHOWN
        .get()
        .and_then(|t| t.lock().ok())
        .map(|t| t.elapsed() < std::time::Duration::from_millis(600))
        .unwrap_or(false)
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 让系统别给窗口画它自己那 8px 圆角，否则会把 CSS 的 26px 切掉
pub(crate) fn no_system_rounding(win: &tauri::WebviewWindow) {
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;
        const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
        const DWMWCP_DONOTROUND: i32 = 1;
        let pref = DWMWCP_DONOTROUND;
        unsafe {
            DwmSetWindowAttribute(
                hwnd.0,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &pref as *const i32 as *mut core::ffi::c_void,
                std::mem::size_of::<i32>() as u32,
            );
        }
    }
    #[cfg(not(windows))]
    let _ = win;
}

/// 托盘菜单用自绘窗口：原生系统菜单是直角、无图标，无法做圆角
fn show_tray_menu(app: &tauri::AppHandle, click_x: i32, click_y: i32) {
    if let Some(win) = app.get_webview_window(TRAY_MENU) {
        place_near_click(&win, click_x, click_y);
        let _ = win.show();
        let _ = win.set_focus();
        mark_menu_shown();
        return;
    }

    let builder = WebviewWindowBuilder::new(
        app,
        TRAY_MENU,
        WebviewUrl::App("index.html?win=traymenu".into()),
    )
    .title(locale::t("走走菜单"))
    .inner_size(216.0, 226.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false);

    match builder.build() {
        Ok(w) => {
            // 建窗时关阴影会把 WebView 画成空白，只能建成后再关
            #[cfg(windows)]
            let _ = w.set_shadow(false);
            no_system_rounding(&w);
            place_near_click(&w, click_x, click_y);
            let _ = w.show();
            let _ = w.set_focus();
            mark_menu_shown();
        }
        Err(e) => log::error!("托盘菜单创建失败: {e}"),
    }
}

/// 菜单贴着点击点上方弹出（托盘在右下角），全程物理像素并夹在显示器内
fn place_near_click(win: &tauri::WebviewWindow, click_x: i32, click_y: i32) {
    let (Ok(Some(mon)), Ok(size)) = (win.current_monitor(), win.outer_size()) else {
        return;
    };
    let mpos = mon.position();
    let msize = mon.size();
    let w = size.width as i32;
    let h = size.height as i32;
    let min_x = mpos.x;
    let max_x = (mpos.x + msize.width as i32 - w).max(min_x);
    let min_y = mpos.y;
    let max_y = (mpos.y + msize.height as i32 - h).max(min_y);
    let x = (click_x - w + 12).clamp(min_x, max_x);
    let y = (click_y - h - 8).clamp(min_y, max_y);
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

#[tauri::command]
fn tray_action(app: tauri::AppHandle, action: String) {
    if let Some(win) = app.get_webview_window(TRAY_MENU) {
        let _ = win.hide();
    }
    match action.as_str() {
        "show" => show_main(&app),
        "pause" => app
            .state::<Engine>()
            .send(Event::Pause { dur: Some(PAUSE_DURATION) }),
        "skip" => app.state::<Engine>().send(Event::SkipAny),
        "settings" => {
            show_main(&app);
            let _ = app.emit("tray://navigate", "settings");
        }
        "quit" => {
            app.state::<Engine>().finalize();
            app.exit(0);
        }
        _ => {}
    }
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(locale::t("走走 · 正在计时"))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state: MouseButtonState::Up,
                position,
                ..
            } = event
            {
                let (x, y) = (position.x as i32, position.y as i32);
                match button {
                    MouseButton::Left => show_main(tray.app_handle()),
                    MouseButton::Right => show_tray_menu(tray.app_handle(), x, y),
                    _ => {}
                }
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 开机自启拉起的第二个实例不要抢主窗口
            if !argv.iter().any(|a| a == "--autostart") {
                show_main(app);
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .setup(|app| {
            // 「登录后静默启动到托盘，不弹主窗」：自启参数由插件写入启动项
            if std::env::args().any(|a| a == "--autostart") {
                if let Some(win) = app.get_webview_window(MAIN) {
                    let _ = win.hide();
                }
            }
            // release 也写文件日志（轮转、保留最近 3 份），否则线上「没提醒」无从排查
            let level = if cfg!(debug_assertions) && std::env::var("SITLESS_FAST").is_ok() {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            };
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(level)
                    .targets([
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                            file_name: Some("sitless".into()),
                        }),
                    ])
                    .max_file_size(256 * 1024)
                    .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
                    .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                    .build(),
            )?;

            // 数据目录 + SQLite
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let store = std::sync::Arc::new(
                db::Db::open(&data_dir.join("sitless.db")).expect("打开数据库失败"),
            );
            // 先从库读配置，音量决定提示音文件的采样幅度
            let mut rc = RuntimeConfig::from_db(&store);
            if let Err(e) = sound::prepare(&data_dir, rc.prefs.volume) {
                log::warn!("准备提示音失败: {e}");
            }
            // 上次离开留下的未闭合段：隔得近说明只是重启，接着算同一段；
            // 隔得远说明中间关机或没在用，按 exit 收口（exit 不算起身）。
            // 原来无条件按 exit 收口，等于每次重启都把一段正在进行的坐姿切断。
            let gap = rc.idle_threshold.max(5 * MIN);
            match store.open_segment() {
                Ok(Some(o)) => {
                    let now = chrono::Local::now().naive_local();
                    if runtime::can_resume(&o.updated_at, now, gap) {
                        log::info!("[续接] 距上次快照在 {} 秒内，本轮接着上一段", gap / 1000);
                        rc.resume = Some(runtime::ResumeAnchor {
                            started_at: o.started_at,
                            day: o.day,
                            sitting_ms: o.sitting_ms.max(0) as u64,
                        });
                    } else if let Err(e) = store.close_open("exit") {
                        log::warn!("收口未闭合段失败: {e}");
                    }
                }
                Ok(None) => {}
                Err(e) => log::warn!("读取未闭合段失败: {e}"),
            }
            // 启动即留一条基线：排查「没提醒」时先确认进程真的起过、当天算不算工作日
            log::info!(
                "[启动] v{} 数据={} 工作日掩码={} 活动阈值={}min 样式={} 可提醒={}",
                env!("CARGO_PKG_VERSION"),
                data_dir.display(),
                rc.prefs.workdays,
                rc.idle_threshold / 60_000,
                rc.prefs.reminder_style,
                rc.prefs.active_now()
            );
            app.manage(std::sync::Arc::clone(&store));

            // 先起运行时，再建托盘：托盘菜单回调依赖 managed Engine
            let engine = runtime::spawn(app.handle().clone(), rc, store);
            app.manage(engine);
            build_tray(app.handle())?;

            // 开发用：直接把托盘菜单摆出来，便于实机截图核对样式
            if std::env::var("SITLESS_TRAY_PREVIEW").is_ok() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(900));
                    show_tray_menu(&handle, 1880, 1020);
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } if window.label() == MAIN => {
                // 关闭按钮收进托盘，真正退出走托盘菜单
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::Focused(false) if window.label() == TRAY_MENU => {
                // 点到别处才收起；预览模式常显，便于实机截图核对样式
                if !menu_shown_recently()
                    && std::env::var("SITLESS_TRAY_PREVIEW").is_err()
                {
                    let _ = window.hide();
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            runtime::status,
            runtime::preview_alert,
            runtime::pause,
            runtime::resume,
            runtime::skip,
            runtime::dismiss,
            reminder::close_alert,
            reminder::close_light,
            reminder::alert_ready,
            reminder::alert_reposition,
            runtime::today,
            runtime::trend,
            runtime::hourly,
            runtime::diag,
            runtime::update_config,
            runtime::segments,
            runtime::preview,
            runtime::preview_tone,
            runtime::autostart_state,
            runtime::set_autostart,
            runtime::export_csv,
            runtime::export_diagnostics,
            runtime::reveal_path,
            runtime::clear_history,
            runtime::set_ui_language,
            tray_action
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}

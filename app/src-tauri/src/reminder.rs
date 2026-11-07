//! 提醒落地：系统通知、警戒置顶窗、轻量置顶浮窗、提示音

use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

pub const ALERT: &str = "alert";

/// 呈现层当前形态：0=已隐藏 1=轻浮窗 2=警戒窗。状态机不感知这一层。
static MODE: AtomicU8 = AtomicU8::new(0);
/// 每次 show 自增。轻浮窗的延时关窗靠序号校验，避免把被警戒抢占后的窗口关掉。
static SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Light,
    Alert,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::Light => "light",
            Mode::Alert => "alert",
        }
    }

    fn as_u8(self) -> u8 {
        match self {
            Mode::Light => 1,
            Mode::Alert => 2,
        }
    }
}

/// 轻提醒：系统 Toast，不抢焦点
pub fn toast(app: &AppHandle, title: &str, body: &str) {
    // 系统通知之外，同步给主窗口一份，用来画右上角的轻提醒卡片
    let _ = app.emit(
        "reminder://toast",
        serde_json::json!({ "title": title, "body": body }),
    );
    if let Err(e) = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show()
    {
        log::warn!("通知发送失败: {e}");
    }
}

/// 轻提醒（置顶窗档）：不抢焦点、由前端 9 秒后自动收起。
/// 警戒窗是否正在显示由 show_window_now 在主线程判定（需要读窗口可见性）。
pub fn show_light(app: &AppHandle) {
    show_window(app, Mode::Light);
}

/// 警戒：抢焦点的完整置顶窗
pub fn show_alert(app: &AppHandle) {
    show_window(app, Mode::Alert);
}

/// 把建窗/显示排进主线程事件队列
///
/// 不能在 IPC 命令里直接 `WebviewWindowBuilder::build()`：WebView2 控制器初始化
/// 要等主线程消息循环，而命令正占着主线程，会互相等死 —— 表现为窗口停在默认
/// 坐标、页面停在 about:blank 一片空白、命令也不返回。
fn show_window(app: &AppHandle, mode: Mode) {
    let handle = app.clone();
    // 先换线程再投递：run_on_main_thread 在当前已是主线程时会同步立即执行
    // （tauri-runtime-wry::send_user_message 的判断），那就还是卡在 IPC 回调里。
    std::thread::spawn(move || {
        let for_task = handle.clone();
        if let Err(e) = handle.run_on_main_thread(move || show_window_now(&for_task, mode)) {
            log::error!("置顶窗调度失败: {e}");
            MODE.store(0, Ordering::Relaxed);
        }
    });
}

/// MODE 只是缓存：窗口可能被外部隐藏 / 销毁而没走 close_* 命令。
/// 每次显示前用窗口真实可见性校正，避免陈旧的 MODE=2 一直吞掉轻提醒。
fn reconcile_mode(app: &AppHandle) {
    match app.get_webview_window(ALERT) {
        None => MODE.store(0, Ordering::Relaxed),
        Some(win) => {
            if !win.is_visible().unwrap_or(true) {
                MODE.store(0, Ordering::Relaxed);
            }
        }
    }
}

fn show_window_now(app: &AppHandle, mode: Mode) {
    reconcile_mode(app);
    // 只有窗口确实可见的警戒窗才压制轻提醒；被抑制时不占用 SEQ，
    // 否则会让仍在显示中的轻浮窗的延时关窗请求作废。
    if mode == Mode::Light && MODE.load(Ordering::Relaxed) == 2 {
        log::info!("[抑制][轻浮窗] 警戒窗正在显示");
        return;
    }

    let seq = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    MODE.store(mode.as_u8(), Ordering::Relaxed);

    if let Some(win) = app.get_webview_window(ALERT) {
        // 先显示再定位：隐藏窗口的 current_monitor / outer_size 可能拿不到，
        // 而且 show 必须在主线程调用，放到线程里会静默失败。
        let _ = win.show();
        // 复用窗口时 URL 不能改，用定向事件切模式与序号
        let _ = win.emit(
            "alert://show",
            serde_json::json!({ "mode": mode.as_str(), "seq": seq }),
        );
        if mode == Mode::Alert {
            // 警戒重申时重抽插画 / 主色 / 文案并重置倒计时
            let _ = win.emit("alert://reset", ());
        }
        place_bottom_right(app, &win);
        let _ = win.unminimize();
        if mode == Mode::Alert {
            let _ = win.set_focus();
        }
        return;
    }

    // 首次建窗把 mode / seq 写进 URL：此时 WebView 还没挂载，事件会丢，
    // 首帧靠 query 拿到正确模式，fitWindow 才能按内容量高度。
    let url = format!("index.html?win=alert&mode={}&seq={}", mode.as_str(), seq);
    let (init_w, init_h) = if mode == Mode::Light {
        (320.0, 176.0)
    } else {
        (320.0, 380.0)
    };
    let builder = WebviewWindowBuilder::new(app, ALERT, WebviewUrl::App(url.into()))
        .title(crate::locale::t("该起身了"))
        .inner_size(init_w, init_h)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        // 先隐藏，等窗口摆好位置再显示；显示前不要做定位
        .visible(false);

    match builder.build() {
        Ok(w) => {
            // 建窗时关阴影会把 WebView 画成空白，只能建成后再关
            #[cfg(windows)]
            let _ = w.set_shadow(false);
            crate::no_system_rounding(&w);

            // 显示前按主显示器估一个右下角，避免第一帧闪在默认坐标
            if let Ok(Some(mon)) = app.primary_monitor() {
                let scale = mon.scale_factor();
                let (x, y) = bottom_right(
                    &mon,
                    (init_w * scale) as i32,
                    (init_h * scale) as i32,
                );
                let _ = w.set_position(PhysicalPosition::new(x, y));
            }
            // WebView 只有窗口可见才会绘制，隐藏窗口会一直空白
            let _ = w.show();
            place_bottom_right(app, &w);
            if mode == Mode::Alert {
                let _ = w.set_focus();
            }
        }
        Err(e) => {
            log::error!("置顶窗创建失败: {e}");
            MODE.store(0, Ordering::Relaxed);
        }
    }
}

fn bottom_right(mon: &tauri::Monitor, w: i32, h: i32) -> (i32, i32) {
    let mpos = mon.position();
    let msize = mon.size();
    let scale = mon.scale_factor();
    // 逻辑像素边距：卡片外还有 12px 透明阴影区，所以这里给得比目测更紧；
    // 底部仍留在任务栏上方（任务栏约 48px）
    let margin_x = (12.0 * scale) as i32;
    let margin_y = (52.0 * scale) as i32;
    let x = (mpos.x + msize.width as i32 - w - margin_x).max(mpos.x);
    let y = (mpos.y + msize.height as i32 - h - margin_y).max(mpos.y);
    (x, y)
}

/// 贴主显示器右下角，全程物理像素；窗口还没映射时用主显示器兜底
fn place_bottom_right(app: &AppHandle, win: &WebviewWindow) {
    let Ok(size) = win.outer_size() else {
        return;
    };
    let mon = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(mon) = mon else {
        return;
    };
    let (x, y) = bottom_right(&mon, size.width as i32, size.height as i32);
    let _ = win.set_position(PhysicalPosition::new(x, y));
}

/// 前端内容渲染完成后调用：重新贴右下角并显示，避免空白首帧。
/// 轻浮窗不抢焦点，只有警戒窗 set_focus。
#[tauri::command]
pub fn alert_ready(app: AppHandle) {
    if let Some(win) = app.get_webview_window(ALERT) {
        place_bottom_right(&app, &win);
        let _ = win.show();
        if MODE.load(Ordering::Relaxed) == 2 {
            let _ = win.set_focus();
        }
    }
}

/// 前端按内容把窗口改高之后，重新贴回右下角
#[tauri::command]
pub fn alert_reposition(app: AppHandle) {
    if let Some(win) = app.get_webview_window(ALERT) {
        place_bottom_right(&app, &win);
    }
}

/// 用户点了「已起身 / 跳过 / 暂停」或轻浮窗右上角 × 后收起弹窗，窗口保留复用
#[tauri::command]
pub fn close_alert(app: AppHandle) {
    if let Some(win) = app.get_webview_window(ALERT) {
        let _ = win.hide();
    }
    MODE.store(0, Ordering::Relaxed);
}

/// 轻浮窗 9 秒自动收起。序号对不上说明已被警戒抢占 / 被重申覆盖 / 已经关过，
/// 此时必须忽略，否则会把刚升级的警戒窗一起关掉。
#[tauri::command]
pub fn close_light(app: AppHandle, seq: u64) {
    if seq != SEQ.load(Ordering::Relaxed) || MODE.load(Ordering::Relaxed) != 1 {
        return;
    }
    if let Some(win) = app.get_webview_window(ALERT) {
        let _ = win.hide();
    }
    MODE.store(0, Ordering::Relaxed);
}

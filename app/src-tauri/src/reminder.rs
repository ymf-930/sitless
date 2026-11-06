//! 提醒落地：系统通知、警戒置顶窗、提示音

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

pub const ALERT: &str = "alert";

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

/// 警戒：把建窗/显示排进主线程事件队列
///
/// 不能在 IPC 命令里直接 `WebviewWindowBuilder::build()`：WebView2 控制器初始化
/// 要等主线程消息循环，而命令正占着主线程，会互相等死 —— 表现为窗口停在默认
/// 坐标、页面停在 about:blank 一片空白、命令也不返回。托盘菜单是从托盘事件回调
/// 建窗所以没事，这里统一走队列规避。
pub fn show_alert(app: &AppHandle) {
    let handle = app.clone();
    // 先换线程再投递：run_on_main_thread 在当前已是主线程时会同步立即执行
    // （tauri-runtime-wry::send_user_message 的判断），那就还是卡在 IPC 回调里。
    std::thread::spawn(move || {
        let for_task = handle.clone();
        if let Err(e) = handle.run_on_main_thread(move || show_alert_now(&for_task)) {
            log::error!("警戒窗调度失败: {e}");
        }
    });
}

fn show_alert_now(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(ALERT) {
        // 先显示再定位：隐藏窗口的 current_monitor / outer_size 可能拿不到，
        // 而且 show 必须在主线程调用，放到线程里会静默失败。
        let _ = win.show();
        place_bottom_right(app, &win);
        let _ = win.unminimize();
        let _ = win.set_focus();
        // 复用窗口时通知前端重置倒计时
        let _ = win.emit("alert://reset", ());
        return;
    }

    let builder = WebviewWindowBuilder::new(
        app,
        ALERT,
        WebviewUrl::App("index.html?win=alert".into()),
    )
    .title(crate::locale::t("该起身了"))
    .inner_size(320.0, 380.0)
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
                    (320.0 * scale) as i32,
                    (380.0 * scale) as i32,
                );
                let _ = w.set_position(PhysicalPosition::new(x, y));
            }
            // WebView 只有窗口可见才会绘制，隐藏窗口会一直空白
            let _ = w.show();
            place_bottom_right(app, &w);
            let _ = w.set_focus();
        }
        Err(e) => log::error!("警戒窗创建失败: {e}"),
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

/// 前端内容渲染完成后调用：重新贴右下角并显示，避免空白首帧
#[tauri::command]
pub fn alert_ready(app: AppHandle) {
    if let Some(win) = app.get_webview_window(ALERT) {
        place_bottom_right(&app, &win);
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 前端按内容把窗口改高之后，重新贴回右下角
#[tauri::command]
pub fn alert_reposition(app: AppHandle) {
    if let Some(win) = app.get_webview_window(ALERT) {
        place_bottom_right(&app, &win);
    }
}

/// 用户点了「已起身 / 跳过 / 暂停」后收起弹窗，窗口保留复用
#[tauri::command]
pub fn close_alert(app: AppHandle) {
    if let Some(win) = app.get_webview_window(ALERT) {
        let _ = win.hide();
    }
}

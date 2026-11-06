//! 后端用户可见文案的语言状态。
//!
//! `auto` 的解析在前端（读 navigator.language），解析完把结果同步过来；
//! 后端只保留一个原子量，不落库、不影响设置项本身。

use std::sync::atomic::{AtomicU8, Ordering};

/// 0 = 中文，1 = 英文
static LANG: AtomicU8 = AtomicU8::new(0);

pub fn set(lang: &str) {
    LANG.store(
        if lang.eq_ignore_ascii_case("en") { 1 } else { 0 },
        Ordering::Relaxed,
    );
}

pub fn is_en() -> bool {
    LANG.load(Ordering::Relaxed) == 1
}

/// 固定文案：中文原文 → 英文，未收录时原样返回。
pub fn t(zh: &str) -> String {
    if !is_en() {
        return zh.to_string();
    }
    match zh {
        "该起身活动一下了" => "Time to get up and move",
        "站起来走 1 分钟。" => "Walk around for a minute.",
        "刚才全屏期间有几次提醒" => "Reminders during fullscreen",
        "走走 · 已暂停" => "Zouzou · Paused",
        "走走 · 休息中" => "Zouzou · Resting",
        "走走 · 正在计时" => "Zouzou · Tracking",
        "该起身了" => "Time to get up",
        "走走菜单" => "Zouzou menu",
        _ => zh,
    }
    .to_string()
}

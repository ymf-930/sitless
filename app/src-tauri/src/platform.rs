//! 平台能力：离座检测与全屏/勿扰判定
//!
//! 决策：不可用时降级而不是失败——idle 拿不到就返回 None，由运行时退回「始终在座」，
//! 并在设置页明示「本环境不支持离座检测」。

/// 距最后一次键鼠输入的毫秒数；拿不到返回 None
#[cfg(windows)]
pub fn idle_ms() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    unsafe {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut info) == 0 {
            return None;
        }
        let now = GetTickCount();
        Some(now.wrapping_sub(info.dwTime) as u64)
    }
}

#[cfg(not(windows))]
pub fn idle_ms() -> Option<u64> {
    None
}

/// 当前是否处于「不该打扰」的状态（全屏、演示、游戏、勿扰）
///
/// Windows: SHQueryUserNotificationState 取值 5 才表示可以正常通知。
/// 返回 None 表示查询失败，调用方按「不抑制」处理。
#[cfg(windows)]
pub fn should_suppress() -> Option<bool> {
    use windows_sys::Win32::UI::Shell::SHQueryUserNotificationState;

    const QUNS_ACCEPTS_NOTIFICATIONS: i32 = 5;

    unsafe {
        let mut state: i32 = 0;
        let hr = SHQueryUserNotificationState(&mut state);
        if hr != 0 {
            return None;
        }
        Some(state != QUNS_ACCEPTS_NOTIFICATIONS)
    }
}

#[cfg(not(windows))]
pub fn should_suppress() -> Option<bool> {
    None
}

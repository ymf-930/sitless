//! 内置提示音：按配置音量缩放 PCM 后写到数据目录，PlaySoundW 异步播放
//!
//! 不引音频库：WAV 是 16-bit PCM，找到 data chunk 后把每个采样乘 volume/100。
//! 音量变化时重写全部文件即可，播放端不用改。音源由 `scripts/make_sounds.py` 合成。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const FILES: [(&str, &[u8]); 3] = [
    ("marimba.wav", include_bytes!("../sounds/marimba.wav")),
    ("bell.wav", include_bytes!("../sounds/bell.wav")),
    ("soft.wav", include_bytes!("../sounds/soft.wav")),
];

static SOUND_DIR: OnceLock<PathBuf> = OnceLock::new();

/// data chunk 的数据起点（"data" 4 字节 + size 4 字节）
fn data_offset(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|w| w == b"data")
        .map(|i| i + 8)
}

/// 按音量缩放 PCM；不改变文件长度
fn scaled(bytes: &[u8], volume: u8) -> Vec<u8> {
    let mut out = bytes.to_vec();
    let Some(start) = data_offset(bytes) else {
        return out;
    };
    if start >= out.len() {
        return out;
    }
    let gain = volume as f32 / 100.0;
    for chunk in out[start..].chunks_exact_mut(2) {
        let sample = i16::from_le_bytes([chunk[0], chunk[1]]) as f32 * gain;
        let v = sample.clamp(-32768.0, 32767.0) as i16;
        let b = v.to_le_bytes();
        chunk[0] = b[0];
        chunk[1] = b[1];
    }
    out
}

fn write_all(dir: &Path, volume: u8) -> std::io::Result<()> {
    for (name, bytes) in FILES {
        let mut f = std::fs::File::create(dir.join(name))?;
        f.write_all(&scaled(bytes, volume))?;
    }
    Ok(())
}

/// 启动时按配置音量准备音频
pub fn prepare(app_dir: &Path, volume: u8) -> std::io::Result<()> {
    let dir = app_dir.join("sounds");
    std::fs::create_dir_all(&dir)?;
    // 换过音源后这两份旧文件不再使用，留着只会占空间
    for legacy in ["blow.wav", "dingdong.wav"] {
        let _ = std::fs::remove_file(dir.join(legacy));
    }
    write_all(&dir, volume)?;
    let _ = SOUND_DIR.set(dir);
    Ok(())
}

/// 音量改动后重写音频文件
pub fn set_volume(volume: u8) -> std::io::Result<()> {
    let Some(dir) = SOUND_DIR.get() else {
        return Ok(());
    };
    // 停止正在播放的声音，避免读到写到一半的文件
    stop();
    write_all(dir, volume)
}

fn stop() {
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::Media::Audio::PlaySoundW(
            std::ptr::null(),
            std::ptr::null_mut(),
            0,
        );
    }
}

pub fn play(tone: u8) {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Media::Audio::PlaySoundW;

        const SND_FILENAME: u32 = 0x0002_0000;
        const SND_ASYNC: u32 = 0x0001;
        const SND_NODEFAULT: u32 = 0x0002;

        let Some(dir) = SOUND_DIR.get() else {
            return;
        };
        let idx = (tone as usize).min(FILES.len() - 1);
        let path = dir.join(FILES[idx].0);
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            PlaySoundW(
                wide.as_ptr(),
                std::ptr::null_mut(),
                SND_FILENAME | SND_ASYNC | SND_NODEFAULT,
            );
        }
    }
    #[cfg(not(windows))]
    let _ = tone;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaling_changes_samples_but_not_length() {
        let raw = FILES[0].1;
        let quiet = scaled(raw, 20);
        let loud = scaled(raw, 100);
        assert_eq!(quiet.len(), raw.len());
        assert_eq!(loud, raw.to_vec(), "100% 应等于原始数据");
        let off = data_offset(raw).unwrap();
        // 合成音有淡入，第一个采样接近 0，取一个明显非零的位置比较
        let idx = raw[off..]
            .chunks_exact(2)
            .position(|c| i16::from_le_bytes([c[0], c[1]]).abs() > 1000)
            .expect("应存在非零采样")
            * 2
            + off;
        let a = i16::from_le_bytes([quiet[idx], quiet[idx + 1]]);
        let b = i16::from_le_bytes([raw[idx], raw[idx + 1]]);
        assert!(a.abs() < b.abs(), "20% 的采样幅度应更小");
    }

    #[test]
    fn zero_volume_is_silent() {
        let raw = FILES[2].1;
        let off = data_offset(raw).unwrap();
        let silent = scaled(raw, 0);
        assert!(silent[off..].chunks_exact(2).all(|c| c == [0, 0]));
    }
}

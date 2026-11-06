"""生成应用内置提示音（22050 Hz / 单声道 / 16-bit PCM）。

设计约束：
- 播放端是 Win32 `PlaySoundW` + 自写的 PCM 缩放（按 2 字节采样做增益），
  所以必须是 16-bit 未压缩 WAV，不能是 float 或 24-bit。
- 基调控制在 400–700 Hz，衰减短、无长延音，避免工作中被声音黏住。
- 起音用升余弦斜坡，收尾做 3ms 淡出，避免爆音。

用法: python make_sounds.py
"""

import math
import struct
import wave
from pathlib import Path

SR = 22050
OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "sounds"
PEAK = 0.80  # 归一化峰值，留 20% 余量给音量放大


def _attack_ramp(n, attack_s):
    """升余弦起音，返回 0~1 的包络前段。"""
    a = max(2, int(attack_s * SR))
    out = [0.0] * n
    for i in range(min(a, n)):
        out[i] = 0.5 - 0.5 * math.cos(math.pi * i / a)
    for i in range(a, n):
        out[i] = 1.0
    return out


def tone(freq, partials, dur, attack=0.004):
    """按 (频率倍数, 振幅, 衰减秒, 失谐音分) 叠加一个音。"""
    n = int(dur * SR)
    buf = [0.0] * n
    ramp = _attack_ramp(n, attack)
    for ratio, amp, decay, detune in partials:
        f = freq * ratio * (2 ** (detune / 1200))
        w = 2 * math.pi * f / SR
        for i in range(n):
            t = i / SR
            buf[i] += amp * math.exp(-t / decay) * math.sin(w * i)
    return [b * r for b, r in zip(buf, ramp)]


def glide(f_start, f_end, tau, dur, attack=0.003, decay=0.12, harmonic=0.0):
    """频率指数滑落，用来做水滴那种「啵」的音。"""
    n = int(dur * SR)
    buf = [0.0] * n
    ramp = _attack_ramp(n, attack)
    phase = 0.0
    for i in range(n):
        t = i / SR
        f = f_end + (f_start - f_end) * math.exp(-t / tau)
        phase += 2 * math.pi * f / SR
        v = math.sin(phase) + harmonic * math.sin(2 * phase)
        buf[i] = v * math.exp(-t / decay) * ramp[i]
    return buf


def mix(*tracks):
    """把若干（起始秒, 采样）叠到同一条时间轴上。"""
    end = max(int(off * SR) + len(buf) for off, buf in tracks)
    out = [0.0] * end
    for off, buf in tracks:
        s = int(off * SR)
        for i, v in enumerate(buf):
            out[s + i] += v
    return out


def write(name, samples, peak=PEAK):
    top = max(abs(x) for x in samples) or 1.0
    gain = peak / top
    n = len(samples)
    fade = int(0.003 * SR)
    data = bytearray()
    for i, x in enumerate(samples):
        v = x * gain
        if i >= n - fade:  # 收尾淡出，避免截断爆音
            v *= (n - i) / fade
        data += struct.pack("<h", max(-32768, min(32767, int(round(v * 32767)))))
    path = OUT / name
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(bytes(data))
    peak_i = max(abs(v) for v in struct.unpack("<%dh" % (len(data) // 2), bytes(data)))
    rms = math.sqrt(sum(v * v for v in struct.unpack("<%dh" % (len(data) // 2), bytes(data))) / (len(data) // 2))
    print(f"{name:12s} {n / SR:4.2f}s  peak {peak_i:5d}  rms {rms:6.0f}  {len(data):6d}B")


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    # 0 木琴：C5，基音长衰减 + 两个敲击泛音，温暖不刺耳
    write(
        "marimba.wav",
        tone(
            523.25,
            [(1.0, 1.0, 0.30, 0), (3.93, 0.28, 0.07, 0), (9.20, 0.09, 0.03, 0)],
            0.70,
            attack=0.004,
        ),
    )

    # 1 铃：E5 → C5 两声，带非谐泛音，像门口风铃
    strike = lambda f: tone(
        f,
        [
            (1.00, 1.0, 0.55, 0),
            (2.01, 0.34, 0.34, 0),
            (2.99, 0.17, 0.24, 0),
            (4.20, 0.09, 0.15, 0),
            (5.43, 0.05, 0.10, 0),
        ],
        0.80,
        attack=0.002,
    )
    write("bell.wav", mix((0.0, strike(659.25)), (0.30, strike(523.25))))

    # 2 软提示：D5 弱二泛音 + 轻微失谐叠音，起音慢，最不打扰
    write(
        "soft.wav",
        tone(
            587.33,
            [(1.0, 1.0, 0.20, 0), (1.0, 0.35, 0.20, 7), (2.0, 0.14, 0.10, 0)],
            0.55,
            attack=0.032,
        ),
    )

    # 3 水滴：1300Hz 快速滑到 420Hz，短促清亮
    write("drop.wav", glide(1300.0, 420.0, 0.035, 0.40, decay=0.10, harmonic=0.18), peak=0.86)

    # 4 木鱼：三根短衰减泛音，一下「笃」，最短最不占注意力
    write(
        "wood.wav",
        tone(
            780.0,
            [(1.00, 1.0, 0.045, 0), (1.63, 0.48, 0.030, 0), (2.70, 0.22, 0.020, 0)],
            0.22,
            attack=0.0015,
        ),
        peak=0.94,  # 时长短，响度补一点，听感和其它几个持平
    )


if __name__ == "__main__":
    main()

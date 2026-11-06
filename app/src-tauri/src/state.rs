//! 双轴计时状态机（纯逻辑：无 IO、无系统时间、无随机）
//!
//! 语义见 `.workbuddy/memory/2026-11-04.md`，关键不变量：
//! - 两轴独立：活动提醒（轻）与久坐警戒（重）。警戒命中时吞掉同刻轻提醒并重置轻轴节拍。
//! - 暂停只关提醒，计时照走；暂停区间计入坐姿时长与最长连续段。
//! - 段的边界只有两种：离座、跨零点。暂停 / 跳过 / 提醒都不切段。
//! - 未响应每 `repeat_interval` 重申，`repeat_limit` 次封顶；之后每 `quota_window` 重置配额。
//! - 全屏期间不弹、不耗配额，退出后只补一条汇总。

#![allow(dead_code)] // 待 step3 接入 tick 循环后移除

pub type Ms = u64;

pub const MIN: Ms = 60_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Axis {
    /// 活动提醒轴（轻提示）
    Activity,
    /// 久坐警戒轴（置顶弹窗）
    Alert,
}

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub activity_interval: Ms,
    pub alert_threshold: Ms,
    pub repeat_interval: Ms,
    pub repeat_limit: u8,
    pub quota_window: Ms,
    pub pause_default: Ms,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            activity_interval: 45 * MIN,
            alert_threshold: 120 * MIN,
            repeat_interval: 5 * MIN,
            repeat_limit: 3,
            quota_window: 30 * MIN,
            pause_default: 15 * MIN,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    Toast { at: Ms },
    Modal { at: Ms },
    Summary { count: u8, at: Ms },
    UpsertSegment { start: Ms, sitting: Ms },
    CloseSegment { start: Ms, sitting: Ms, continuous: Ms },
    RolloverDay { at: Ms },
}

#[derive(Clone, Debug)]
pub enum Event {
    /// 推进时间到 now（毫秒，单调递增）
    Tick { now: Ms },
    /// 是否在座（平台侧已按 idle 阈值判定）
    Presence { present: bool },
    /// 暂停；`Some(ms)` 为「从现在起 ms 毫秒后自动恢复」，`None` 为暂停到手动恢复
    Pause { dur: Option<Ms> },
    Resume,
    /// 跳过：不清零，只推迟该轴
    Skip { axis: Axis },
    /// 已起身：结算当前段并清零重计
    Dismiss,
    /// 托盘快捷操作：跳过当前所有挂起提醒（不清零）
    SkipAny,
    Fullscreen { on: bool },
    Midnight,
    /// 清空全部记录：由运行时拦截，清库并把计时器归零（不结算旧段）
    ClearAll,
}

#[derive(Clone, Copy, Debug, Default)]
struct AxisState {
    /// 距该轴上次发提醒的累计
    accum: Ms,
    /// 本轮已提醒次数（含首次）
    repeats: u8,
    /// 存在未响应的提醒
    awaiting: bool,
}

#[derive(Clone, Debug)]
pub struct Timer {
    pub config: Config,
    now: Ms,
    seg_start: Ms,
    sitting: Ms,
    activity: AxisState,
    alert: AxisState,
    present: bool,
    /// 外层 Some = 暂停中；内层 Some = 定时恢复，None = 手动恢复
    paused: Option<Option<Ms>>,
    fullscreen: bool,
    suppressed: u8,
    last_upsert: Ms,
}

impl Timer {
    pub fn new(now: Ms, config: Config) -> Self {
        Self {
            config,
            now,
            seg_start: now,
            sitting: 0,
            activity: AxisState::default(),
            alert: AxisState::default(),
            present: true,
            paused: None,
            fullscreen: false,
            suppressed: 0,
            last_upsert: now,
        }
    }

    /// 本段累计坐姿时长（含暂停区间）
    pub fn sitting(&self) -> Ms {
        self.sitting
    }

    pub fn is_paused(&self) -> bool {
        self.paused.is_some()
    }

    pub fn is_present(&self) -> bool {
        self.present
    }

    pub fn alert_threshold(&self) -> Ms {
        self.config.alert_threshold
    }

    pub fn activity_interval(&self) -> Ms {
        self.config.activity_interval
    }

    pub fn repeat_interval(&self) -> Ms {
        self.config.repeat_interval
    }

    pub fn repeat_limit(&self) -> u8 {
        self.config.repeat_limit
    }

    /// 距警戒触发还有多久（挂起时是距下次重申）
    pub fn next_alert_in(&self) -> Ms {
        if self.alert.awaiting {
            self.config.repeat_interval.saturating_sub(self.alert.accum)
        } else {
            self.config.alert_threshold.saturating_sub(self.alert.accum)
        }
    }

    /// 距下次轻提醒还有多久
    pub fn next_activity_in(&self) -> Ms {
        if self.activity.awaiting {
            self.config
                .repeat_interval
                .saturating_sub(self.activity.accum)
        } else {
            self.config
                .activity_interval
                .saturating_sub(self.activity.accum)
        }
    }

    fn quiet(&self) -> bool {
        self.paused.is_some() || self.fullscreen
    }

    fn axis_mut(&mut self, axis: Axis) -> &mut AxisState {
        match axis {
            Axis::Activity => &mut self.activity,
            Axis::Alert => &mut self.alert,
        }
    }

    pub fn apply(&mut self, ev: Event) -> Vec<Effect> {
        let mut fx = Vec::new();
        match ev {
            Event::Tick { now } => {
                let dt = now.saturating_sub(self.now);
                self.now = now.max(self.now);
                if dt > 0 {
                    self.advance(dt, &mut fx);
                }
                if self.now.saturating_sub(self.last_upsert) >= MIN {
                    self.last_upsert = self.now;
                    fx.push(Effect::UpsertSegment {
                        start: self.seg_start,
                        sitting: self.sitting,
                    });
                }
            }
            Event::Presence { present } => {
                if self.present && !present {
                    // 离座即结算本段，计时停走
                    self.present = false;
                    self.close_segment(&mut fx);
                } else if !self.present && present {
                    // 平台侧已按阈值过滤，回来即开新段
                    self.present = true;
                    self.restart_segment();
                }
            }
            Event::Pause { dur } => {
                // dur 是「从现在起多久」，必须换算成绝对时刻；否则运行超过
                // 15 分钟后再暂停会立刻到期（原来把时长当成 until 比较）
                self.paused = Some(dur.map(|d| self.now.saturating_add(d)));
            }
            Event::Resume => {
                self.paused = None;
            }
            Event::Skip { axis } => {
                // 不清零，只把该轴推迟到下一个触发点
                *self.axis_mut(axis) = AxisState::default();
            }
            Event::SkipAny => {
                self.activity = AxisState::default();
                self.alert = AxisState::default();
            }
            Event::Dismiss => {
                // 已起身：结算当前段，重新开始
                self.close_segment(&mut fx);
                self.restart_segment();
            }
            Event::Fullscreen { on } => {
                if self.fullscreen && !on {
                    self.fullscreen = false;
                    if self.suppressed > 0 {
                        fx.push(Effect::Summary {
                            count: self.suppressed,
                            at: self.now,
                        });
                        self.suppressed = 0;
                        // 汇总后按「刚提醒过」重置，避免退出全屏立即再弹
                        let limit = self.config.repeat_limit;
                        reset_after_emit(&mut self.activity, limit);
                        reset_after_emit(&mut self.alert, limit);
                    }
                } else {
                    self.fullscreen = on;
                }
            }
            Event::Midnight => {
                self.close_segment(&mut fx);
                self.seg_start = self.now;
                self.sitting = 0;
                self.last_upsert = self.now;
                fx.push(Effect::RolloverDay { at: self.now });
            }
            // 运行时收到 ClearAll 时不会调用 apply，这里只作兜底
            Event::ClearAll => self.reset_all(),
        }
        fx
    }

    fn advance(&mut self, dt: Ms, fx: &mut Vec<Effect>) {
        if let Some(Some(until)) = self.paused {
            if self.now >= until {
                self.paused = None;
            }
        }
        if !self.present {
            return;
        }

        self.sitting += dt;

        // 静默期（暂停 / 全屏）：只累计，不推进提醒节拍、不消耗配额。
        // 暂停恢复时 accum 已越过阈值，会自然补一条；全屏则按周期计一次被抑制。
        if self.quiet() {
            self.activity.accum += dt;
            self.alert.accum += dt;
            if self.fullscreen {
                let c = self.config;
                if self.activity.accum >= c.activity_interval {
                    self.activity.accum = 0;
                    self.suppressed = self.suppressed.saturating_add(1);
                }
                if self.alert.accum >= c.alert_threshold {
                    self.alert.accum = 0;
                    self.suppressed = self.suppressed.saturating_add(1);
                }
            }
            return;
        }

        self.activity.accum += dt;
        self.alert.accum += dt;

        // 警戒优先：命中则吞掉同刻轻提醒并重置轻轴节拍
        let alert_due = self.due(Axis::Alert);
        if alert_due {
            self.fire(Axis::Alert, fx);
            self.activity = AxisState::default();
            return;
        }

        if self.due(Axis::Activity) {
            self.fire(Axis::Activity, fx);
        }
    }

    /// 该轴是否到点：首次阈值、重申间隔、配额重置三种情况统一在这里判定
    fn due(&self, axis: Axis) -> bool {
        let (st, threshold) = match axis {
            Axis::Activity => (&self.activity, self.config.activity_interval),
            Axis::Alert => (&self.alert, self.config.alert_threshold),
        };
        if !st.awaiting {
            return st.accum >= threshold;
        }
        if st.accum < self.config.repeat_interval {
            return false;
        }
        st.repeats < self.config.repeat_limit || st.accum >= self.config.quota_window
    }

    fn fire(&mut self, axis: Axis, fx: &mut Vec<Effect>) {
        let quiet = self.quiet();
        let fullscreen = self.fullscreen;
        let limit = self.config.repeat_limit;

        if quiet {
            // 防御分支：正常流程下 advance 已提前返回
            if fullscreen {
                self.suppressed = self.suppressed.saturating_add(1);
            }
            return;
        }

        let st = self.axis_mut(axis);
        if st.awaiting && st.repeats >= limit {
            reset_after_emit(st, limit); // 配额重置，重新开始一轮
        } else {
            st.awaiting = true;
            st.repeats = st.repeats.saturating_add(1);
            st.accum = 0;
        }

        fx.push(match axis {
            Axis::Activity => Effect::Toast { at: self.now },
            Axis::Alert => Effect::Modal { at: self.now },
        });
    }

    /// 清空全部记录后从零开始：不结算旧段，也不补发被抑制的汇总
    pub fn reset_all(&mut self) {
        self.seg_start = self.now;
        self.sitting = 0;
        self.activity = AxisState::default();
        self.alert = AxisState::default();
        self.suppressed = 0;
        self.last_upsert = self.now;
    }

    /// 退出前取走当前段并归零，返回 (时长, 连续时长)
    pub fn take_segment(&mut self) -> Option<(Ms, Ms)> {
        if self.sitting == 0 {
            return None;
        }
        let out = (self.sitting, self.sitting);
        self.sitting = 0;
        self.activity = AxisState::default();
        self.alert = AxisState::default();
        Some(out)
    }

    fn close_segment(&mut self, fx: &mut Vec<Effect>) {
        if self.sitting > 0 {
            fx.push(Effect::CloseSegment {
                start: self.seg_start,
                sitting: self.sitting,
                continuous: self.sitting,
            });
        }
    }

    fn restart_segment(&mut self) {
        self.seg_start = self.now;
        self.sitting = 0;
        self.activity = AxisState::default();
        self.alert = AxisState::default();
        self.last_upsert = self.now;
    }
}

fn reset_after_emit(st: &mut AxisState, limit: u8) {
    st.awaiting = true;
    st.repeats = 1.min(limit.max(1));
    st.accum = 0;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 按分钟步进推进，模拟真实 tick 节奏
    fn drive(t: &mut Timer, from: Ms, to: Ms) -> Vec<Effect> {
        let mut fx = Vec::new();
        let mut now = from;
        while now < to {
            now = (now + MIN).min(to);
            fx.extend(t.apply(Event::Tick { now }));
        }
        fx
    }

    fn toasts(fx: &[Effect]) -> usize {
        fx.iter().filter(|e| matches!(e, Effect::Toast { .. })).count()
    }

    fn modals(fx: &[Effect]) -> usize {
        fx.iter().filter(|e| matches!(e, Effect::Modal { .. })).count()
    }

    fn upserts(fx: &[Effect]) -> usize {
        fx.iter()
            .filter(|e| matches!(e, Effect::UpsertSegment { .. }))
            .count()
    }

    fn timer() -> Timer {
        Timer::new(0, Config::default())
    }

    #[test]
    fn activity_fires_at_interval() {
        let mut t = timer();
        let fx = drive(&mut t, 0, 45 * MIN);
        assert_eq!(toasts(&fx), 1, "45 分钟应触发一次轻提醒");
        assert_eq!(modals(&fx), 0);
        assert_eq!(t.sitting(), 45 * MIN);
    }

    #[test]
    fn alert_swallows_activity_in_same_tick() {
        let mut t = timer();
        // 一次性推进 120 分钟：警戒命中时不应再补一条轻提醒
        let fx = t.apply(Event::Tick { now: 120 * MIN });
        assert_eq!(modals(&fx), 1);
        assert_eq!(toasts(&fx), 0, "警戒命中应吞掉同刻轻提醒");
    }

    #[test]
    fn pause_silences_but_keeps_counting() {
        let mut t = timer();
        t.apply(Event::Pause { dur: Some(120 * MIN) });
        let fx = drive(&mut t, 0, 60 * MIN);
        assert_eq!(toasts(&fx), 0, "暂停期间不弹");
        assert_eq!(t.sitting(), 60 * MIN, "暂停期间仍计入坐姿时长");
    }

    #[test]
    fn resume_fires_once_not_backlog() {
        let mut t = timer();
        t.apply(Event::Pause { dur: Some(90 * MIN) });
        let fx = drive(&mut t, 0, 60 * MIN);
        assert_eq!(toasts(&fx), 0, "暂停期间不弹");
        t.apply(Event::Resume);
        let fx = drive(&mut t, 60 * MIN, 63 * MIN);
        assert_eq!(toasts(&fx), 1, "恢复后只补一条，不刷屏");
    }

    #[test]
    fn away_stops_clock_and_resets_on_return() {
        let mut t = timer();
        drive(&mut t, 0, 10 * MIN);
        let fx = t.apply(Event::Presence { present: false });
        assert!(
            matches!(fx.as_slice(), [Effect::CloseSegment { sitting, .. }] if *sitting == 10 * MIN),
            "离座应结算当前段"
        );
        let fx = drive(&mut t, 10 * MIN, 40 * MIN);
        assert_eq!(t.sitting(), 10 * MIN, "离座期间不再累计");
        assert_eq!(upserts(&fx), 30, "离座期间仍按分钟落库快照");

        t.apply(Event::Presence { present: true });
        assert_eq!(t.sitting(), 0, "回来即开新段");
    }

    #[test]
    fn skip_defers_without_reset() {
        let mut t = timer();
        drive(&mut t, 0, 45 * MIN);
        t.apply(Event::Skip { axis: Axis::Activity });
        let fx = drive(&mut t, 45 * MIN, 46 * MIN);
        assert_eq!(toasts(&fx), 0, "跳过后不立即重弹");
        assert_eq!(t.sitting(), 46 * MIN, "跳过不清零");
        let fx = drive(&mut t, 46 * MIN, 90 * MIN);
        assert_eq!(toasts(&fx), 1, "跳过后从当前时刻重新计 45 分钟");
    }

    #[test]
    fn dismiss_closes_segment() {
        let mut t = timer();
        drive(&mut t, 0, 50 * MIN);
        let fx = t.apply(Event::Dismiss);
        assert!(
            matches!(fx.as_slice(), [Effect::CloseSegment { sitting, .. }] if *sitting == 50 * MIN)
        );
        assert_eq!(t.sitting(), 0, "已起身从零开始");
    }

    #[test]
    fn repeats_thrice_then_waits_for_quota() {
        let mut t = timer();
        let fx = drive(&mut t, 0, 120 * MIN);
        assert_eq!(modals(&fx), 1);

        // 未响应：每 5 分钟重申，共 3 次
        let fx = drive(&mut t, 120 * MIN, 131 * MIN);
        assert_eq!(modals(&fx), 2, "125 / 130 各一次");

        // 配额耗尽：最后一次在 130，静默到 160（30 分钟窗口）
        let fx = drive(&mut t, 131 * MIN, 159 * MIN);
        assert_eq!(modals(&fx), 0, "3 次用完进入静默");

        // 满 30 分钟配额窗口后重置
        let fx = drive(&mut t, 159 * MIN, 161 * MIN);
        assert_eq!(modals(&fx), 1, "配额重置后重新提醒");
    }

    #[test]
    fn fullscreen_suppresses_then_one_summary() {
        let mut t = timer();
        t.apply(Event::Fullscreen { on: true });
        let fx = drive(&mut t, 0, 200 * MIN);
        assert_eq!(toasts(&fx), 0);
        assert_eq!(modals(&fx), 0, "全屏期间不弹");

        let fx = t.apply(Event::Fullscreen { on: false });
        let summaries = fx
            .iter()
            .filter(|e| matches!(e, Effect::Summary { .. }))
            .count();
        assert_eq!(summaries, 1, "退出全屏只补一条汇总");
        if let Some(Effect::Summary { count, .. }) = fx.first() {
            assert!(*count >= 2, "应累计多次被抑制的提醒，实际 {count}");
        }
    }

    #[test]
    fn midnight_closes_segment() {
        let mut t = timer();
        drive(&mut t, 0, 100 * MIN);
        let fx = t.apply(Event::Midnight);
        assert!(
            matches!(fx.as_slice(), [Effect::CloseSegment { sitting, .. }, Effect::RolloverDay { .. }] if *sitting == 100 * MIN)
        );
        assert_eq!(t.sitting(), 0, "新的一天从零开始");
    }

    #[test]
    fn upserts_once_per_minute() {
        let mut t = timer();
        let fx = drive(&mut t, 0, 5 * MIN);
        assert_eq!(upserts(&fx), 5);
    }

    #[test]
    fn timed_pause_is_relative_to_now() {
        let mut t = timer();
        drive(&mut t, 0, 20 * MIN);
        t.apply(Event::Pause { dur: Some(15 * MIN) });
        drive(&mut t, 20 * MIN, 34 * MIN);
        assert!(
            t.is_paused(),
            "已运行 20 分钟时暂停 15 分钟，34 分钟仍应在暂停中；把时长当成绝对时刻会立刻恢复"
        );
        drive(&mut t, 34 * MIN, 36 * MIN);
        assert!(!t.is_paused(), "35 分钟应自动恢复");
    }

    #[test]
    fn reset_all_clears_without_closing_old_segment() {
        let mut t = timer();
        drive(&mut t, 0, 50 * MIN);
        t.reset_all();
        assert_eq!(t.sitting(), 0);
        let fx = drive(&mut t, 50 * MIN, 51 * MIN);
        assert!(fx.iter().all(|e| !matches!(e, Effect::CloseSegment { .. })), "旧段不应被结算回来");
    }

    #[test]
    fn manual_pause_never_auto_resumes() {
        let mut t = timer();
        t.apply(Event::Pause { dur: None });
        let fx = drive(&mut t, 0, 300 * MIN);
        assert!(t.is_paused());
        assert_eq!(toasts(&fx) + modals(&fx), 0);
        t.apply(Event::Resume);
        assert!(!t.is_paused());
    }
}

// 全项目数值常量的唯一出处。每条都标注契约/ADR 出处，禁止在别处另起一份阈值。

// --- 命中掩膜（契约 §3.3 R-2/R-4/R-10，ADR 0002） ---
export const MASK_WIDTH = 128;
export const MASK_HEIGHT = 72;
export const HIT_ALPHA_THRESHOLD = 0.5; // R-4
/**
 * 头部区（R-10）的**降级**口径：掩膜 alpha 包围盒顶部 22%。
 *
 * ADR 0040 起这只是兜底：首选口径是"以头骨为圆心、`HEAD_PAT_RADIUS_RATIO × 内容区高度`为半径"。
 * 废弃原因见 ADR 0039 的排查日志：本资产的光环在掩膜里不透明，会把包围盒顶部顶到光环上沿，
 * 22% 的下边界落在**发顶之上**（实测 y≈228–275），她的脸（y≈340–420）整块在带外，
 * 于是"点她的脸"永远判 `head=false`、`head_patted` 永不触发。
 */
export const HEAD_BAND_RATIO = 0.22;
/**
 * 头部区首选口径的半径比例（ADR 0040）：`R = 0.125 × 内容区高度`。
 *
 * 422×720 窗口下 R = 90px。实测头骨 y≈343、发顶 y≈260、脸 y≈350–420、光环 y≈120–205：
 * 半径 90 的圆恰好覆盖"发顶 → 下巴"，同时**排除光环**——点光环不再算摸头
 * （验收标准：y≈120–205 不触发）。
 */
export const HEAD_PAT_RADIUS_RATIO = 0.125; // R-10（ADR 0040）
export const MASK_REFRESH_INTERVAL_MS = 50; // R-5：≥20Hz，与渲染帧率解耦
export const MASK_STALE_MS = 100; // R-5
/**
 * 探针活跃窗口：超过这么久没有收到 `cmd:probe`，渲染侧暂停采集。
 * R-5 要求"光标离开窗口矩形则暂停采集"，但渲染侧看不到光标位置，
 * 只能以"主进程还在探"作为活跃信号；主进程一旦停止探测即为离开。
 */
export const MASK_PROBE_ACTIVE_WINDOW_MS = 250;

// --- 指针与穿透（契约 §3.3 R-6/R-7、D-5、§12、ADR 0002） ---
export const POINTER_POLL_INTERVAL_MS = 16; // 唯一的光标轮询周期
export const LEAVE_HYSTERESIS_PX = 8; // R-7
export const PASSTHROUGH_SWITCH_COOLDOWN_MS = 100; // R-7
export const PROBE_TIMEOUT_MS = 200; // ADR 0004 D4
export const HEAD_PROBE_MAX_DISTANCE_PX = 8; // ADR 0004 D1.6
export const HEAD_PROBE_MAX_AGE_MS = 100; // ADR 0004 D1.6

// --- 手势（契约 §3.4） ---
export const DRAG_START_THRESHOLD_PX = 4; // D-2
export const HEAD_PAT_MAX_DURATION_MS = 250; // D-3
export const HEAD_PAT_COOLDOWN_MS = 800; // D-4
export const REBOUND_SETTLE_MS = 500; // ADR 0004 D3：估计值，不是观测值

/**
 * 末速度的采样窗口（D-6 的"末速度"实现口径，不是契约阈值）。
 * 只取抬手前这段时间内的光标采样做平均，避免把整段拖拽的平均速度当成末速度。
 */
export const DRAG_VELOCITY_WINDOW_MS = 100;

// --- 窗口几何（契约 §3.2、§3.4 D-7、ADR 0003、ADR 0004 D8） ---
export const WINDOW_WIDTH_PX = 480;
export const WINDOW_HEIGHT_PX = 720;
export const INPUT_BAR_WIDTH_PX = 260;
export const INPUT_BAR_HEIGHT_PX = 44;
export const INPUT_BAR_GAP_PX = 8;
export const WORKAREA_MIN_KEEP_WIDTH_PX = 80; // D-7
export const WORKAREA_MIN_KEEP_HEIGHT_PX = 120; // D-7

// --- 编排（契约 §9.1–§9.4、§12；ADR 0015 D1） ---
export const LLM_HEALTH_TIMEOUT_MS = 800; // 健康检查（/api/tags）
export const LLM_HARD_TIMEOUT_MS = 8000; // §9.1 硬超时
export const LLM_TEMPERATURE = 0.8; // §9.4
export const LLM_MAX_PREDICT = 256; // 单条回复的 token 上限（≈120 字）
export const LLM_HISTORY_TURNS = 6; // §9.3 段 4：最近 6 轮
export const REPLY_TEXT_MAX_CHARS = 120; // §7.4 / §9.2
export const RULE_DEFAULT_COOLDOWN_MS = 4000; // 台词池条目的缺省冷却
export const RULE_PAT_MAX_AGE_MS = 4000; // head_patted 规则的有效窗口

// --- 语音 TTS（契约 §7.4；ADR 0015 D2） ---
export const SPEECH_TEXT_MAX_CHARS = 120; // >120 → failed，不截断
export const TTS_FIRST_BYTE_TIMEOUT_MS = 3000; // 契约默认值；CPU 非流式部署可覆盖
export const TTS_TOTAL_TIMEOUT_MS = 30000; // 契约默认值；同上
/**
 * 合成文本的语种（回复文本）。本轮起角色**只讲日文** → ja（ADR 0022；修订 ADR 0019 D1 的 zh）。
 * 参考音频也是日文，因此本机默认值是"参考语种 = 合成语种 = ja"。
 * 可用 `PET_TTS_TEXT_LANG` 覆盖（例如临时切回中文做对照）。
 */
export const TTS_TEXT_LANG = 'ja';
/**
 * 参考音频/参考文本的语种。本机凯伊参考音频是**日文**，因此默认 ja；
 * 换参考音频语种时必须同时改 `PET_TTS_PROMPT_LANG` 与 `PET_TTS_PROMPT_TEXT`（ADR 0019）。
 */
export const TTS_PROMPT_LANG = 'ja';
export const TTS_TEXT_SPLIT_METHOD = 'cut5';
export const TTS_SPEED_FACTOR = 1.0;

// --- 语音播放与口型（契约 §5.2、§7.4；ADR 0010 D2、ADR 0015 D4） ---
export const ENVELOPE_WINDOW_MS = 30; // RMS 窗口
export const ENVELOPE_NOISE_GATE = 0.06; // 低于此值的窗视为静音
export const ENVELOPE_ATTACK = 0.55; // level 上升的平滑系数
export const ENVELOPE_RELEASE = 0.3; // level 下降的平滑系数
export const MOUTH_LEVELS = 8; // 8 级张口度 → 图集帧 0..7
export const MOUTH_UPDATE_MIN_INTERVAL_MS = 33; // 嘴部重绘 ≤30Hz（ADR 0010 成本项）
/**
 * "闭嘴"在**官方嘴型图集**里的帧号（ADR 0046 D3.2：7 → **0**）。
 *
 * 逐帧目视复核（`Character_Mouth_High-BgFqI_9W.png` 8×8）：
 * `0` 平直细线（抿嘴，最像"闭嘴"）/ `7` 上扬小弧（微笑）/ `8` 下垂弧（不满）/
 * `14` 小椭圆（微张）/ `6` 扁小椭圆（微张）/ `2` 宽张（白齿）/ `1`/`4`/`9` 张口。
 * 上一版用 7：弧线在"情绪嘴型"的尺寸下会被看成一个小圆（"常驻微张"），
 * 现在统一用 **0**，任何人一眼都能看出是闭着的。
 */
export const MOUTH_FRAME_CLOSED = 0;
/**
 * 口型的**四档元音**（ADR 0045 D4.2）：闭 → 微张 → 中张 → 大张。
 * 用固定 4 档而不是 `round(level·7)` 的连续量化，因为 8 级在稳定电平下只会停在
 * 同一帧（真机表现："说话时永远只有一张嘴"）。
 */
export const MOUTH_VISEME_FRAMES = [MOUTH_FRAME_CLOSED, 6, 1, 2] as const;
/** 同一档位内轮换用的"大张口"备选帧（与 2 交替，模拟不同元音） */
export const MOUTH_VISEME_WIDE_ALTERNATE = 9;
/**
 * 档内轮换的槽长（ms）：每 180ms 在"同档的另一个张口帧"之间换一次。
 * 太快（<100ms）会闪，太慢（>300ms）又回到"定格"。
 */
export const MOUTH_VISEME_SLOT_MS = 180;

// --- 字幕气泡（契约 §3.2 R-1、§2 shell；ADR 0015 D3、ADR 0021） ---
export const SUBTITLE_HOLD_MS = 6000; // 无语音可对齐时的停留时长
export const SUBTITLE_FADE_MS = 180;
/** 语音结束后的尾巴：让用户读完最后一行再淡出（ADR 0021 D4）。 */
export const SUBTITLE_TAIL_MS = 1200;
/**
 * 待显示字幕的 failsafe（ADR 0021 D6）：`intent_resolved` 之后等这么久还没有
 * `speech_started` 就直接显示。取值必须明显大于本机实测合成耗时（4.2–6.2s），
 * 否则会把"正常但慢"的合成误判成异常，反而破坏时序对齐。
 */
export const SUBTITLE_PENDING_FAILSAFE_MS = 15000;

// --- 记忆（契约 §7.5、§9.3 段 3；ADR 0020） ---
export const MEMORY_RETRIEVE_LIMIT = 5; // 契约 §7.5：默认 5
export const MEMORY_RETRIEVE_LIMIT_MAX = 20; // 契约 §7.5：上限 20
/** 单次查询最多取这么多个词条（含 CJK 的三字滑窗），防止 OR 表达式过长。 */
export const MEMORY_QUERY_MAX_TERMS = 8;
export const MEMORY_TERM_MAX_CHARS = 24;
/** 每个检索路径（FTS / LIKE）的候选上限，保证最坏情况仍是有界读（ADR 0020 D4）。 */
export const MEMORY_CANDIDATE_LIMIT = 80;
/**
 * LIKE 降级最多查这么多个词条：LIKE 是逐词全表扫，词条数直接决定最坏耗时。
 * 4 个词条 × 500 行实测仍在 1–2ms 量级；超过这个数就不值得再扫（ADR 0020 D4）。
 */
export const MEMORY_LIKE_TERM_LIMIT = 4;
export const MEMORY_TEXT_MAX_CHARS = 2000; // 单条记忆正文上限（超出截断）
export const MEMORY_FACT_MAX_CHARS = 120; // 段 3 里单条展示上限
export const MEMORY_TAG_MAX = 8;
export const MEMORY_TAG_MAX_CHARS = 40;
/** 检索延迟预算（契约 §7.5：≤ 50ms）；只用于自检/单测断言，不是运行期超时。 */
export const MEMORY_RETRIEVE_BUDGET_MS = 50;

// --- 在场感 presence（ADR 0030 D1/D5） ---
/**
 * presence 的采样节流：`getSnapshot()` 至多每 2s 真正调一次 Win32。
 * **不是定时器**——没有 setInterval，读的时候才判断是否需要重采；
 * 因此不构成契约 §12 所说的"第二个轮询器"（那一条说的是 16ms 指针轮询）。
 */
export const PRESENCE_SAMPLE_INTERVAL_MS = 2000;
/** 前台窗口标题在 presence 里的硬截断：只为段 3.5 用，不需要完整标题 */
export const PRESENCE_TITLE_MAX_CHARS = 80;

// --- 世界事实与段 3.5（ADR 0030 D2/D3；ADR 0032 D1/D2） ---
/** 段 3.5「环境事实」的最大字符数：单行、可截断，保证它永远不会顶掉段 4/5 */
export const WORLD_SEGMENT_MAX_CHARS = 160;
/** 判定"用户正在输入"的阈值：小于它就不提"多久之前" */
export const WORLD_TYPING_ACTIVE_MS = 5000;
/**
 * 段 3.5 里"前台应用"标签的截断上限。
 * 本轮起标签是归一化类别（`coding` / `other: <类名>`），只有 `other:` 的长类名才可能超长。
 */
export const WORLD_APP_TITLE_MAX_CHARS = 48;

// --- 生命周期心跳（ADR 0033） ---
/**
 * 生命周期心跳的节拍：15s。它**只**做生命周期任务（目前唯一一件 = 冷启动预热），
 * 与 idle-drive 的 15s 主动性节拍（`PROACTIVE_TICK_MS`）各自独立：
 * 关掉主动性，心跳照常；自检里心跳整个不启动。
 */
export const HEARTBEAT_TICK_MS = 15000;

// --- 冷启动 LLM 预热（ADR 0032 D3；调度方于 ADR 0033 改为生命周期心跳） ---
/**
 * 预热请求的超时。它买的是**模型加载**时间（CPU 上 4B 量级首次加载可到几十秒），
 * 不是推理时间；给得比 `LLM_HARD_TIMEOUT_MS` 宽得多，且不占用任何对话预算。
 */
export const LLM_WARMUP_TIMEOUT_MS = 60000;
/** 预热失败后的重试间隔（同一会话最多 `LLM_WARMUP_MAX_ATTEMPTS` 次） */
export const LLM_WARMUP_RETRY_MS = 60000;
/** 同一会话最多尝试几次预热：失败 3 次就放弃，避免对着一个关着的 Ollama 每 15s 敲一次 */
export const LLM_WARMUP_MAX_ATTEMPTS = 3;
/** 预热只生成 1 个 token：目的只是把权重读进内存，不要算力 */
export const LLM_WARMUP_NUM_PREDICT = 1;

// --- 托盘只读诊断（ADR 0032 D4） ---
/**
 * 托盘诊断项的刷新节流：挂在既有 16ms 指针轮询器的 `onTick` 上（与吸附跟随同一手法），
 * **不新开定时器**；5000ms 远大于人观察托盘菜单的粒度。
 */
export const TRAY_STATS_REFRESH_MS = 5000;

// --- 记忆段的相对时间与预算（ADR 0030 D4） ---
/**
 * 段 3 全部记忆行的总字符上限。
 * 5 条 × 120 字上限 = 600 字的最坏情况会把段 3 顶到角色卡的两倍，
 * 这里压到 360：宁可少两条，也不让"记忆"压过"角色卡"。
 */
export const MEMORY_SEGMENT_MAX_CHARS = 360;
/** 两条记忆被判为"重复"的三字组 Jaccard 阈值（同 tags 时才比较） */
export const MEMORY_DEDUPE_SIMILARITY = 0.8;

// --- 主动性 idle-drive（ADR 0031 D2/D3） ---
/** 评估节拍：15s 一次。**不是**指针轮询器，也不参与穿透/位移（§12） */
export const PROACTIVE_TICK_MS = 15000;
/** 系统键鼠空闲超过这么久，才认为"用户没在操作" */
export const PROACTIVE_MIN_USER_IDLE_MS = 90000;
/** 空闲超过这么久，认为"用户可能离开了"——此时不打扰（ADR 0031 D2.2） */
export const PROACTIVE_MAX_USER_IDLE_MS = 300000;
/** 距上一次用户主动交互（说话/摸头）至少这么久 */
export const PROACTIVE_MIN_INTERACTION_GAP_MS = 90000;
/** 两次主动开口之间的冷却：10 分钟 */
export const PROACTIVE_COOLDOWN_MS = 600000;
/** 每会话主动开口总预算（规则 + LLM 合并计）：12 次 */
export const PROACTIVE_SESSION_BUDGET = 12;
/** 深夜（23:00–07:00）预算减半 → 6 次 */
export const PROACTIVE_NIGHT_START_HOUR = 23;
export const PROACTIVE_NIGHT_END_HOUR = 7;
/** 主动路径的 LLM 超时：3s。超时即沉默，**绝不**走兜底（ADR 0031 D4） */
export const PROACTIVE_LLM_TIMEOUT_MS = 3000;

// --- 行走（契约 §4.1 `walking`、§5.3、§12；ADR 0024） ---
/** idle 持续这么久之后才可能触发一次行走（§4.1 的 20s 下限） */
export const WALK_INTERVAL_MIN_MS = 20000;
export const WALK_INTERVAL_MAX_MS = 40000;
export const WALK_DISTANCE_MIN_PX = 100;
export const WALK_DISTANCE_MAX_PX = 300;
/** 巡航速度：100–300px 约 1–3s，太快不像"走"，太慢会被当成卡住 */
export const WALK_SPEED_PX_PER_SEC = 110;
/** 起步/停步加速度：配合刹车曲线 v=√(2ad)，起步与停步都不生硬 */
export const WALK_ACCEL_PX_PER_SEC2 = 520;

// --- 回弹（契约 §5.3"拖拽松手"、D-6；ADR 0024 D2/D3；参数改口径见 ADR 0040 D3） ---
/** 刚度 k；与下面的阻尼一起决定"弹一下"的手感（ζ ≈ 0.5，欠阻尼） */
export const SETTLE_STIFFNESS = 140;
export const SETTLE_DAMPING = 12;
/**
 * 触地速度保留率（恢复系数）。
 *
 * ADR 0024 D2 原值 0.28 → 窗口会**整块反跳一次**（实测 vy 948 → −169、2137 → −491，
 * 位移 15–40px），视觉上就是"拖完弹一下"，被误读成摸头（ADR 0039 排查）。
 * ADR 0040 D3 调为 0.15：保留一点弹性，反跳幅度降到 ~1/2 以下，几乎看不出来。
 */
export const SETTLE_RESTITUTION = 0.15;
export const SETTLE_MIN_BOUNCE_SPEED = 60;
/** 水平惯性衰减（1/s）：甩出去的水平速度按 e^(-5t) 收敛 */
export const SETTLE_FRICTION = 5;
/** 回弹兜底上限：超过这么久强制静止（防止极端参数下永不收敛） */
export const SETTLE_MAX_MS = 2500;
/** 落地缓冲（渲染侧的极短下蹲，不参与窗口位移） */
export const SETTLE_SQUASH_MS = 180;
export const SETTLE_SQUASH_RATIO = 0.06;

// --- 记忆保留（ADR 0025） ---
/** 超过这个行数就从最旧的开始淘汰（按 at 升序） */
export const MEMORY_MAX_ROWS = 2000;
/** 单次 prune 最多删这么多行：把最坏耗时锁在毫秒级，剩余的下次再删 */
export const MEMORY_PRUNE_BATCH_MAX = 200;

// --- 前台窗口吸附（契约 §4.1 `sitting`、§6.3 `snap_*`；ADR 0028） ---
/** 吸附热键：默认 Ctrl+Shift+S，被占用降级 Ctrl+Alt+S（与输入条热键同一套三级降级） */
export const SNAP_HOTKEY_DEFAULT = 'Control+Shift+S';
export const SNAP_HOTKEY_FALLBACK = 'Control+Alt+S';
/**
 * 跟随目标窗口的轮询节流（ms）。挂在既有 16ms 轮询器的 onTick 上，
 * 不新开定时器（契约 §12）；120ms ≈ 8 帧一次，拖动/缩放窗口时肉眼无延迟感。
 */
export const SNAP_FOLLOW_INTERVAL_MS = 120;
/** 可作为吸附目标的前台窗口最小尺寸（DIP）：比这更小的窗口吸附上去没有意义 */
export const SNAP_MIN_TARGET_WIDTH_PX = 80;
export const SNAP_MIN_TARGET_HEIGHT_PX = 40;
/** 全屏判定容差（DIP）：窗口矩形与显示器 bounds 的差在这个范围内即视为全屏 */
export const SNAP_FULLSCREEN_TOLERANCE_PX = 2;
/**
 * 允许的贴边误差（DIP）：吸附后的位置被 D-7 夹回工作区时，若离目标边缘线超过这么多，
 * 就不再"假装吸附"——她会被摆在一个明显不在边缘的位置上，宁可拒绝并提示（ADR 0028 D3）。
 */
export const SNAP_MAX_CLAMP_PX = 40;
/**
 * 回退模式（没有 koffi）的"物理贴边"距离：拖拽松手时窗口底边离工作区下沿
 * 不超过这么多像素，就吸到下沿并坐下（她本来就落在这条线上，只是把姿态换成坐）。
 */
export const SNAP_EDGE_DRAG_THRESHOLD_PX = 24;

// --- 吸附接近（契约 §4.1 `sitting` 生命周期、§6.3；ADR 0034） ---
/** 小于这个距离直接落座，不做接近动画（视觉上无感） */
export const SNAP_APPROACH_INSTANT_PX = 8;
/** |dy| 不超过这个值算"同一地面线"，走水平接近；否则用跳跃弧线 */
export const SNAP_APPROACH_WALK_MAX_DY_PX = 16;
/** 接近时长钳制（ms）：太短像瞬移，太长像卡住 */
export const SNAP_APPROACH_MIN_MS = 220;
export const SNAP_APPROACH_MAX_MS = 900;
/** 水平接近的巡航速度（px/s）；复用行走的速度量级 */
export const SNAP_APPROACH_WALK_SPEED_PX_PER_SEC = 260;
/** 跳跃接近的基准时长与距离除数：duration = clamp(base + dist/divisor, min, max) */
export const SNAP_APPROACH_LEAP_BASE_MS = 300;
export const SNAP_APPROACH_LEAP_DISTANCE_DIVISOR = 2400;
/** 跳跃弧高：max(最小, 比值 × 水平距离)，再钳制到最大（屏幕坐标向上为负） */
export const SNAP_APPROACH_ARC_RATIO = 0.12;
export const SNAP_APPROACH_ARC_MIN_PX = 16;
export const SNAP_APPROACH_ARC_MAX_PX = 80;

// --- 拖拽手感（ADR 0035） ---
/** 抓取带：头部 = 包围盒顶部 22%（与 R-10 同源）；脚部 = 底部 20% */
export const GRAB_FOOT_BAND_RATIO = 0.2;
/** 像素世界里的等效重力；只用于单摆，不参与窗口位移 */
export const DRAG_GRAVITY_PX_PER_SEC2 = 2600;
/** 单摆积分固定子步长（与 shared/motion.ts 的 stepSpring 同手法） */
export const DRAG_PENDULUM_SUBSTEP_SECONDS = 0.004;
/** 支撑点速度/加速度滤波：两级 EMA + 死区，压住窗口 1px 量化的噪声 */
export const DRAG_SUPPORT_VELOCITY_EMA_MS = 55;
export const DRAG_SUPPORT_ACCEL_EMA_MS = 90;
export const DRAG_SUPPORT_ACCEL_DEADBAND = 80;
export const DRAG_SUPPORT_ACCEL_MAX = 6000;
/** 姿态增益淡入/淡出（ms） */
export const DRAG_POSE_RAMP_MS = 180;
export const DRAG_RELEASE_POSE_FADE_MS = 420;

/**
 * 三种抓取的单摆参数（初始标定值，实机可调）。
 * - L：有效摆长（px）；越大越"慢"；
 * - damping：角速度阻尼（1/s）；越小越"甩"；
 * - angleLimit：根骨骼摆角上限（rad），同时受窗口尺寸约束；
 * - struggleHz/struggleRad：抓脚时叠的高频挣扎。
 *
 * **ADR 0041 D1：抓取带只影响这套物理参数，不再决定播哪段官方片段。**
 * 原来的 `liftPx`（整身抬升 4/12/8px）属于"程序化根位移"，已删除：
 * 悬空观感由官方片段 `Formation_Pickup` 自己的姿态给出。
 */
export const DRAG_PENDULUM = {
  head: {
    lengthPx: 374,
    damping: 3.2,
    angleLimitRad: 0.35,
    struggleHz: 0,
    struggleRad: 0,
  },
  body: {
    lengthPx: 230,
    damping: 4.2,
    angleLimitRad: 0.32,
    struggleHz: 0,
    struggleRad: 0,
  },
  foot: {
    lengthPx: 130,
    damping: 0.9,
    angleLimitRad: 0.25,
    struggleHz: 2.5,
    struggleRad: 0.045,
  },
} as const;

/** 抓脚挣扎的踢腿包络周期（ms）：每 0.8–1.4s 一次 */
export const DRAG_FOOT_KICK_MIN_INTERVAL_MS = 800;
export const DRAG_FOOT_KICK_MAX_INTERVAL_MS = 1400;
export const DRAG_FOOT_KICK_DURATION_MS = 180;

// --- 待机小动作（ADR 0041 D4；ADR 0045 起**只剩官方片段**） ---
/**
 * 空闲时"偶尔做一个有趣的小动作"的间隔（ms）。
 *
 * 与待机姿态轮换（22–40s 换一个循环姿势）是两件事：轮换换的是**底噪**，
 * 这里是一次性的小演出。
 *
 * ADR 0045 D1：**原地转圈已删除**。真机反馈"3D 角色原地平移转圈像陀螺，非常出戏"。
 * 现在只剩官方片段 `fidget.shy`（`Cafe_Reaction` 3.2–4.9s 的掩面缩身）；
 * 片段缺失时**什么都不做**（不再回退到程序化动作）。
 */
export const IDLE_FIDGET_MIN_MS = 45_000;
export const IDLE_FIDGET_MAX_MS = 95_000;

// --- 坐姿活体微动（ADR 0044） ---
/**
 * **注意：这里是坐姿所有"活感"的唯一出处。**
 *
 * 上一版把坐姿片段循环 0.42s 来制造动感，结果读作"抽搐"（ADR 0043 D2 被本轮否决）。
 * 现在的分工：官方片段**停帧**提供姿态（骨架基线），所有运动都由本组参数驱动的
 * 程序化微动给出 —— 呼吸、自主张望、眨眼、悬空晃腿。
 */

/** 呼吸周期（ms）：3–4 秒，一定要慢；低于 2.5s 会读成"喘" */
export const SIT_BREATH_PERIOD_MS = 3600;
/** 整体高低浮动（px，峰峰值的一半）：**≤1px**，再大就会和"落地缓冲"混在一起 */
export const SIT_BREATH_FLOAT_PX = 0.9;
/** 胸腔/脊柱的呼吸旋转（rad）：spine + spine1 同向，neck 反向一点点（抬头感） */
export const SIT_BREATH_SPINE_RAD = 0.006;
export const SIT_BREATH_SPINE1_RAD = 0.004;
export const SIT_BREATH_NECK_RAD = -0.0025;
/**
 * 肩膀的呼吸起伏（rad，ADR 0045 D2.3）：锁骨 ±0.02、上臂同幅但相位略领先。
 *
 * 为什么需要：停帧之后只有脊柱在动，肩线完全不动 → 上半身像块板子。
 * 0.02rad ≈ 1.1°，是"看得到但说不出"的量级；再大就会读成"耸肩"。
 */
export const SIT_BREATH_SHOULDER_RAD = 0.02;

/**
 * 自主张望：一次注视保持多久（ms，含随机区间）。
 * ADR 0045 D2.2：3–6s → **2.2–4.2s**，换得更勤才有"东张西望"的活物感。
 */
export const SIT_GAZE_HOLD_MIN_MS = 2200;
export const SIT_GAZE_HOLD_MAX_MS = 4200;
/**
 * 新目标的范围（rad）。
 *
 * ADR 0045 D2.2：**偏向抬头**。她坐的那一帧（14.5–14.7s）自带低头，程序化张望是叠在
 * 这个低头之上的，所以"平视 + 略微抬头"才能抵消掉；全部给正俯角只会让她继续看地。
 * 这里的 pitch 与 `BoneArbiter` 同一口径（**正 = 低头**），所以抬头用负值。
 */
export const SIT_GAZE_YAW_RAD = 0.36;
/** 抬头的幅度区间（rad，负值方向）：3.4°–12.6° */
export const SIT_GAZE_UP_MIN_RAD = 0.06;
export const SIT_GAZE_UP_MAX_RAD = 0.22;
/** 偶尔往下瞄一眼（rad，正值方向），幅度要明显小于抬头 */
export const SIT_GAZE_DOWN_MAX_RAD = 0.06;
/** 选"抬头"而不是"往下"的概率（0..1）：抬头占多数 */
export const SIT_GAZE_UP_CHANCE = 0.72;
/**
 * 眼球相对头部的额外幅度（与 gaze.ts 同一口径）。
 * ADR 0046 D1：坐姿会把眼球基底重置为**绑定姿态**（不再带着片段的"向下看"），
 * 再叠 `gaze × 这个系数` —— 眼睛跟着头一起转，不再死盯地面。
 */
export const SIT_GAZE_EYE_EXTRA = 0.35;
/**
 * 张望的过渡时长（ms，ADR 0045 D2.2）：每次换方向用一个 `easeInOutCubic` 走完，
 * 比指数阻尼"干脆"。220–420ms ≈ 一次自然的转头。
 */
export const SIT_GAZE_MOVE_MIN_MS = 220;
export const SIT_GAZE_MOVE_MAX_MS = 420;
/**
 * 已废弃（ADR 0045 D2.2 起改用固定时长的 easeInOutCubic）：
 * 保留常量只为不破坏旧诊断读数，运行时不再使用。
 */
export const SIT_GAZE_SMOOTH_RATE = 3.2;

/**
 * 坐姿的**微侧身**（rad，绕世界 Y，ADR 0046 D3.1）。
 *
 * 正面 0° 死板地对着镜头，配合"头部完全回正"会显得像证件照；身体先侧 8.6°，
 * 头再由张望带回来，才有"坐在窗沿上偏头看人"的活物感。
 *
 * 加在 `animationRoot.rotation.y` 上、按 `sitGain` 淡入淡出；**头部基准要把它扣掉**
 * （见 `captureSitHeadLevel`），否则头部补偿会把侧身也一起转回去（脖子拧成 90°）。
 */
export const SIT_BODY_YAW_RAD = 0.15;

/**
 * 坐姿头部的**人工微调**（rad，正 = 低头）。ADR 0048 D2。
 *
 * 这个数**不是算出来的**：坐姿把上半身骨骼对齐到站立姿态之后，用键盘 ↑/↓ 现场微调，
 * 直到特写里"肉眼看着她是在看镜头"，再把那个值抄到这里。
 *
 * 0 = 完全照搬站立姿态（不额外低头也不抬头）。
 */
export const SIT_HEAD_TUNE_RAD = 0;

// 停帧状态**不再眨眼**（ADR 0046 D2）：ADR 0044 D4 的 `bone_eye_D_L/R.translation.x`
// 手写位移已整套删除 —— 停帧时没有动画混合与联动，眼皮子骨只会平移不会转，
// 真机表现是"下眼皮被硬拉上去"（翻白眼）。坐姿的灵动感改由呼吸 + 张望承担。

/**
 * 悬空晃腿（ADR 0044 D5；幅度/频率/不对称按 ADR 0045 D3 调整）。
 *
 * - 角速度 2 → **2.6 rad/s**（一个来回 ≈ 2.4s，比原来快一点）；
 * - 大腿 0.08 → **0.17 rad**（≈9.7°），小腿跟随 = 大腿 × 0.8（0.136rad）——
 *   真机上"小腿不跟"会让整条腿像根棍子，膝盖必须折得比上一版明显；
 * - 包络用 `lift^k`：顶部变平 → 抬到位会"停一下"再放下，不是纯余弦的匀速摆动；
 * - **左右不对称**（`RATE_SKEW` / `AMP_SKEW_R` / 左右不同的 `LIFT_POWER`）：
 *   完全对称 + 严格反相读起来就是节拍器。让左腿快 5%、抬得高 11%，
 *   两条腿的相位会缓慢漂移，几秒内看不出规律，但永远不会"同时落地"。
 */
export const SIT_LEG_SWING_RAD_PER_SEC = 2.6;
export const SIT_LEG_THIGH_RAD = 0.17;
/** 小腿弧度（rad）：必须与大腿同步（= 大腿 × SIT_LEG_CALF_RATIO） */
export const SIT_LEG_CALF_RATIO = 0.8;
export const SIT_LEG_CALF_RAD = SIT_LEG_THIGH_RAD * SIT_LEG_CALF_RATIO;
export const SIT_LEG_PHASE_RAD = Math.PI;
/**
 * 抬腿包络的幂次（ADR 0045 D3）：`lift = (0.5 - 0.5cos)^k`。
 * k < 1 → 顶部更平（"抬起来停一下"）、上升/回落更陡；k = 1 就是纯余弦。
 * 左右取不同值（0.66 / 0.82）：同一条曲线上"左腿更快到顶、右腿更慢放下"，
 * 这是**不对称**里最容易被眼睛读出来的一项。
 */
export const SIT_LEG_LIFT_POWER_L = 0.66;
export const SIT_LEG_LIFT_POWER_R = 0.82;
/** 左右摆动速度差（比例）：左 = 基准 × (1+skew)、右 = 基准 × (1-skew) */
export const SIT_LEG_RATE_SKEW = 0.05;
/** 右腿幅度相对左腿的比例（左腿是"主腿"，抬得高一点） */
export const SIT_LEG_AMP_SKEW_R = 0.9;
/**
 * 小腿跟随的相位滞后（rad）：膝盖比大腿**晚一点**折起来。
 * 0.32rad ≈ 周期的 5%（约 70ms）——足以去掉"大腿小腿焊死"的刚体感，
 * 又不会让脚在低点甩出去（小腿只往"折"的方向走，脚永远不会低于静止姿态）。
 */
export const SIT_LEG_CALF_LAG_RAD = 0.32;
/** 晃腿的开启/停止包络（ms）：从 0 平滑升到 1，不允许"啪"地开始晃 */
export const SIT_LEG_RAMP_MS = 600;

/** 整套坐姿微动的总包络（ms）：落座后淡入、解除时淡出，避免切换瞬间跳变 */
export const SIT_MOTION_RAMP_MS = 500;

// --- 落地冲击（契约 §5.3、D-6；ADR 0035 D4；参数与口径改见 ADR 0040 D3） ---
/**
 * 下蹲包络总时长/吸震段（毫秒）。
 * ADR 0035 D4 原值 300/50 → ADR 0040 D3 调为 220/50：更短、更像"落地"而不是"缩一下"。
 */
export const LANDING_DURATION_MS = 220;
export const LANDING_ABSORB_MS = 50;
/**
 * 冲击速度归一化区间（px/s）：低于 min 视为轻放，高于 max 视为重摔。
 *
 * **口径变更（ADR 0040 D3）**：这里的 `v` 现在是 **`drag_released.vy`（松手瞬间的竖直速度）**，
 * 不再是"settling 期间窗口向下峰值速度"。后者在弹簧自由落体时必然饱和（实测 1500–1716px/s），
 * 于是每一次拖拽都被判成"重摔"、恒定压 8%。
 * min 由 150 → 700：松手时向下速度小于 700px/s（正常轻放）不触发下蹲。
 */
export const LANDING_IMPACT_MIN_PX_PER_SEC = 700;
export const LANDING_IMPACT_MAX_PX_PER_SEC = 1000;
/** 最大压扁比例（只缩 Y，脚底不动）。0.08 → 0.03（ADR 0040 D3） */
export const LANDING_MAX_SQUASH = 0.03;
/** 骨骼辅助：脊柱前倾/膝盖弯曲上限（膝盖再大就会让脚离地，实机标定后可能降为 0） */
export const LANDING_SPINE_MAX_RAD = 0.16;
export const LANDING_KNEE_MAX_RAD = 0.16;

// --- 坐姿惊跳（ADR 0034 D5） ---
export const STARTLE_SURPRISED_MS = 400;
export const STARTLE_CLICKED_MS = 120;
export const STARTLE_COMMAND_MS = 260;
export const STARTLE_LOST_MS = 320;

// --- 坐下的过渡与解除下落（ADR 0042） ---
/**
 * "从站到坐"的过渡时长（ms）：官方坐姿片段是瞬间进入坐姿的，直接交叉淡入会读成
 * "融化成坐姿"。这 240ms 里额外叠一个**半蹲**（身体先略高于座面、再落到座面，
 * 同时大腿前弯、脊柱微前倾），眼睛看到的是"她屈膝坐下去了"。
 */
export const SIT_LOWER_MS = 240;
/** 半蹲起点的"悬空高度"（px）：从座面上方这么多开始落下 */
export const SIT_LOWER_LIFT_PX = 14;
/** 半蹲时额外的膝/髋弯曲（rad）与躯干前倾（rad），在 SIT_LOWER_MS 内回到 0 */
export const SIT_LOWER_THIGH_RAD = 0.22;
export const SIT_LOWER_LEAN_RAD = 0.05;
/**
 * 解除吸附时"从窗沿落回地面"的冲击分档（px/s，喂给落地缓冲的 impact 口径）。
 * 窗口消失/全屏时她脚下没有东西，必须落到工作区地面线：shell 用回弹弹簧下落，
 * render 按这个名义竖直速度算冲击（`motion_ended{settle}` 的载荷里没有速度）。
 */
export const SNAP_RELEASE_FALL_VY_PX_PER_SEC = 620;
/** 低于这个离地高度就不必下落（她已经在地面线附近），直接站着换姿势 */
export const SNAP_RELEASE_FALL_MIN_PX = 48;
/**
 * 吸附跟随的"追赶"节流（ms）：目标窗口正在移动时，每个 16ms tick 都重算位置，
 * 目标停下后 `SNAP_FOLLOW_SETTLE_MS` 再退回常规节流（默认 120ms）。
 */
export const SNAP_FOLLOW_CATCHUP_INTERVAL_MS = 16;
export const SNAP_FOLLOW_SETTLE_MS = 220;

// --- 背面法描边（ADR 0038） ---
/**
 * 描边宽度，单位 **屏幕像素**（不是模型单位）。
 *
 * 为什么用像素：相机是正交的、世界单位 = CSS px（`pixelsPerUnit` 把模型单位换算成 px），
 * 所以"在视空间沿法线外扩 N 个像素"天然就是**粗细均匀**的线，不会因为角色缩放/
 * 呼吸压扁/远近而变化。模型单位口径（用户建议的 0.003）在本资产上等于 0.003 × 57538 ≈
 * **172px**，直接照抄会把整个人糊成一坨黑。
 */
export const OUTLINE_WIDTH = 1.5;
/**
 * 头发的描边宽度（比身体细）。
 *
 * 为什么单独一档：本资产的头发是**一张张互相重叠的卡片**，每张卡片的轮廓都会各自
 * 外扩一圈；在几层卡片投影重合的地方（实测侧发轮廓）线宽会叠加，1.2px 叠出来能到
 * 6px，看起来像贴纸黑边。降到 0.7px 后重叠区约 2–3px，单层发梢仍是清晰的一条线。
 */
export const OUTLINE_HAIR_WIDTH = 0.8;
/** 描边颜色：深褐（`0x2a1b1a`）。不用纯黑：纯黑在浅色衣服上像"抠图锯齿" */
export const OUTLINE_COLOR = 0x2a1b1a;
/**
 * 深度偏移（视空间单位 = px）：把描边壳沿视线方向**推远**一点点，避免与共面/近共面的
 * 面部贴图 z-fighting（倒角只在轮廓处露出，推远不影响观感）。
 */
export const OUTLINE_DEPTH_BIAS = 0.6;

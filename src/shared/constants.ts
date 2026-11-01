// 全项目数值常量的唯一出处。每条都标注契约/ADR 出处，禁止在别处另起一份阈值。

// --- 命中掩膜（契约 §3.3 R-2/R-4/R-10，ADR 0002） ---
export const MASK_WIDTH = 128;
export const MASK_HEIGHT = 72;
export const HIT_ALPHA_THRESHOLD = 0.5; // R-4
export const HEAD_BAND_RATIO = 0.22; // R-10
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
export const MOUTH_FRAME_CLOSED = 0; // 闭嘴帧

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

// --- 回弹（契约 §5.3"拖拽松手"、D-6；ADR 0024 D2/D3） ---
/** 刚度 k；与下面的阻尼一起决定"弹一下"的手感（ζ ≈ 0.5，欠阻尼） */
export const SETTLE_STIFFNESS = 140;
export const SETTLE_DAMPING = 12;
/** 触地速度保留率：0.28 ≈ 落地后还能轻弹一次，不无限弹 */
export const SETTLE_RESTITUTION = 0.28;
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

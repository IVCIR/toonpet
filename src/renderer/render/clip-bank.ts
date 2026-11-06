/**
 * 官方片段语义表（ADR 0023）。
 *
 * 模型自带 44 段骨骼动画（`CH0335_*`），本文件只做"语义角色 → 片段名"的映射，
 * 不改资源、不重命名片段、不新增动画数据。换模型时改这张表即可。
 *
 * 为什么需要这层：`animation-controller` 原来只有 idle/held/walk 三个槽位，
 * 其余 41 段全部闲置。桌宠要用的"被拎起 / 摸头反应 / 打招呼 / 开心"在资产里
 * 其实都有对应片段，只是名字是开发代号，不能直接当业务语义用。
 *
 * **朝向是这个表的第一约束**：44 段里有一半是战斗动画（`Normal_*`、`Exs*`、
 * `Vital_*`、`Public01`、`Move_*`），角色是侧身对着镜头的，放到正面桌宠里会
 * "歪着身子"。只有 `Cafe_*` / `Formation_*` / `Carrier*` / `Victory_*` 是正面。
 * 结论来自 `tools/clip-preview` 的逐段胶片条实测，不是猜的。
 *
 * 选择规则与 ADR 0014 D3 一致：精确名 → 模式降级 → 缺失；降级原因进日志。
 */
import * as THREE from 'three';
import {
  SIT_CLIP_HOLD_SECONDS,
  SIT_CLIP_START_SECONDS,
} from '../../shared/constants';

export type ClipRole =
  | 'idle'
  | 'idle.alt1'
  | 'idle.alt2'
  | 'idle.alt3'
  | 'idle.alt4'
  | 'idle.alt5'
  | 'idle.alt6'
  | 'held'
  | 'walk'
  | 'walk.carried'
  | 'sit'
  | 'pat'
  | 'greet'
  | 'nod'
  | 'happy'
  // 以下为侧向战斗片段：只登记、默认不接线（留着做"战斗模式"或转屏演出）
  | 'attack'
  | 'skill'
  | 'panic'
  | 'down'
  | 'revive';

export interface ClipRule {
  /** 首选片段名（模型里的原始名） */
  exact: string;
  /** 降级匹配（按顺序取第一个命中） */
  patterns: RegExp[];
  /** 循环播放（常驻姿态）还是一次性（演出） */
  loop: boolean;
  /**
   * 一次性片段的裁剪窗口（秒）。长演出（`Formation_Pickup` 14s、
   * `Cafe_Reaction` 10.75s）整段播会长时间抢走身体通道，只取需要的区间。
   * `startSeconds` 缺省 0；`maxSeconds` 缺省到片段末尾。循环片段忽略这两个字段。
   */
  startSeconds?: number;
  maxSeconds?: number;
  /**
   * 一次性演出的淡入/淡出（秒）。缺省 0.18 / 0.25（`animation-controller` 的常量）。
   *
   * 为什么要按角色配（ADR 0041 D2）：摸头片段结尾停在"缩着"的姿态，0.25s 淡回
   * 站姿太快，读起来像被切断；给它 0.45s，让"抬头回正"由交叉淡入承担。
   */
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
}

/**
 * 角色 → 片段。`exact` 与 `patterns` 都对着模型原始名写，改模型只改这里。
 *
 * 每个 `exact` 后面的括号是实测结论（胶片条截图在 `tools/clip-preview/shots/`）。
 *
 * **朝向与"根位移"是两条硬约束**（ADR 0023 D7、ADR 0041 D3）：44 段里
 * `Normal_*` / `Exs*` / `Vital_*` / `Public01` / `Move_*` 是侧身，不能用；
 * `*_interaction_*` / `*_Interaction_*` 是过场，**根骨被搬到镜头外**
 * （实测 `Victory_End_interaction_01` 偏左 128px、`Victory_Start_Interaction_02`
 * 偏左 190px，`Victory_End_Interaction_02` 偏左 190px），也不接。
 */
export const CLIP_RULES: Record<ClipRole, ClipRule> = {
  // ---- 常驻姿态（循环，正面）----
  idle: {
    // 正面大厅待机；根骨朝向≈绑定姿态（ADR 0014 D3.1）
    exact: 'CH0335_Cafe_Idle',
    patterns: [/cafe[_\s-]?idle/i, /normal[_\s-]?idle/i, /idle/i],
    loop: true,
  },
  'idle.alt1': {
    // 正面抱臂站姿，换一个待机姿态避免看出循环
    exact: 'CH0335_Formation_Idle',
    patterns: [/formation[_\s-]?idle(?!.*random)/i],
    loop: true,
  },
  'idle.alt2': {
    // 正面静止站姿（双手交叠在身前），几乎不动 —— 最"乖"的一个待机（ADR 0041 D4）
    exact: 'CH0335_Carrier_Idle',
    patterns: [/carrier[_\s-]?idle/i],
    loop: true,
  },
  'idle.alt3': {
    // 正面、双手轻握在胸前、呼吸幅度极小；`Victory_End` 的收势姿态（ADR 0041 D4）
    exact: 'CH0335_Victory_End_Random',
    patterns: [/victory[_\s-]?end[_\s-]?random/i],
    loop: true,
  },
  'idle.alt4': {
    // ADR 0050：正面双手交叠在身前；与 `Carrier_Idle` 的"双手自然下垂"是两种不同站姿。
    // 44 段普查：4s 循环、shrinkRatio 0.001、pitchRange 0.012 —— 只有呼吸/头发在动。
    exact: 'CH0335_Carrier2_Idle',
    patterns: [/carrier2[_\s-]?idle/i],
    loop: true,
  },
  'idle.alt5': {
    // ADR 0050：正面收势站姿（手臂自然垂下）；`Victory_End_Random` 之外的另一个 4s 循环。
    // 注意模式必须锚定整名，不能命中 `Victory_End_Random` / `*_interaction_*`。
    exact: 'CH0335_Victory_End',
    patterns: [/^CH0335_Victory_End$/i],
    loop: true,
  },
  'idle.alt6': {
    // ADR 0050：`Formation_Idle` 的随机变体（同一抱臂姿势、不同的头部/呼吸相位）。
    // 4s 循环、shrinkRatio 0.005、pitchRange 0.016；普查 facing 1.186（正面带一点偏头）。
    exact: 'CH0335_Formation_Idle_Random',
    patterns: [/formation[_\s-]?idle[_\s-]?random/i],
    loop: true,
  },
  held: {
    // ADR 0041 D1：**唯一**的官方悬空片段，抓头/抓身/抓脚**统一**用它。
    //
    // 事实（胶片条 + 普查）：0–1.2s 是从地上被拎起来的屈膝起势，1.4s 之后一直保持
    // "被拎着"的垂姿（手臂垂在身前、膝盖微屈、身体略前倾），14s 内姿态基本不变。
    // 所以**从 0 开始播**：`drag_started` 每一次都从第 0 秒进来，正好获得官方的
    // "被拎起"那一下；拖拽超过 14s 才会循环回起势（已知取舍，见 ADR 0041）。
    //
    // 不再按抓取带切片段：抓取带只影响单摆物理（`DRAG_PENDULUM`），不影响播什么。
    exact: 'CH0335_Formation_Pickup',
    patterns: [/formation[_\s-]?pickup/i, /pickup/i, /carrier[_\s-]?idle/i],
    loop: true,
  },
  walk: {
    // 正面行走循环；根骨无位移，走位由窗口/容器负责
    exact: 'CH0335_Cafe_Walk',
    patterns: [/cafe[_\s-]?walk/i, /carrier2?[_\s-]?walk/i, /move[_\s-]?ing/i],
    loop: true,
  },
  'walk.carried': {
    // 正面走、双手抱在胸前；与 `Cafe_Walk` 实测是同一份数据（普查逐项相同），
    // 只作为 `walk` 的模式降级候选，不单独接线。
    exact: 'CH0335_Carrier2_Walk',
    patterns: [/carrier2?[_\s-]?walk/i],
    loop: true,
  },
  sit: {
    // ADR 0051：**两段式**。进入窗口从 14.2s 起播，到 16.2s 停帧：
    // - 阶段 A（14.2–16.0s）：正常 LoopOnce 播放，让她自然演"坐下 + 第一次张望"。
    //   14.95s 左右有一次头部 0.253rad 的快速转头（实测），这是最容易读成"活人"的一下；
    // - 阶段 B（16.0–16.2s）：继续播到 16.2s 后 clamp 停帧；从 16.0s 起 0.3s 淡入
    //   ADR 0048 的站立上半身覆盖 + 程序化微动。16.2s 是停帧基准。
    //
    // 为什么不是 14.5–14.7（旧版）：那 0.2s 把 14.95s 的转头直接冻掉了，坐下第一秒像假人。
    // 为什么不能到 17.0s：17.0s 之后大腿/小腿开始起身（实测 17.5s 大腿已 1.46rad）。
    exact: 'CH0335_my_event088_pastmemory_01',
    patterns: [/pastmemory/i, /sit[_\s-]?(idle|down|loop)?$/i, /chair|seat/i],
    loop: false,
    startSeconds: SIT_CLIP_START_SECONDS,
    maxSeconds: SIT_CLIP_HOLD_SECONDS,
    fadeInSeconds: 0.45,
    fadeOutSeconds: 0.35,
  },

  // ---- 一次性演出（正面）----
  pat: {
    // ADR 0039 D1 + ADR 0041 D2：摸头反应的官方片段。
    //
    // `Victory_Start_Random` 是**唯一自带闭环**的"害羞缩一下"：
    //   0–0.4s 站姿 → 0.4–0.8s 快速缩身、双手抱到胸前、低头（缩身 13–16%、头 pitch −0.13）
    //   → 0.8–2.0s 保持害羞 → 2.0–2.2s 抬头回正。
    //
    // **窗口收到 2.05s**（旧值 2.4）不是为了截短，而是为了"不要在片段自己 0.2s 的
    // 快速抬头之后立刻又接一个 0.25s 淡出"：2.05s 停在"还缩着"姿态的末端，
    // 抬头/放手全部交给 `fadeOutSeconds = 0.45` 的交叉淡入（实测 0.45s 的过渡
    // 读起来是"慢慢直起身"，而不是"被切断"）。
    //
    // 为什么不继续用 `Cafe_Reaction`（3.5–6.6s）：那一段一直含胸抱手，**没有回正**。
    // `Cafe_Reaction` 只保留给 `greet` / `nod`（都是显式意图，不由空闲触发；ADR 0050
    // 又删掉了唯一由空闲触发的 `fidget.shy` 窗口）。
    //
    // 武器/道具由 HIDE_ATTACHMENTS 隐藏；整段脚底高度只变化 0.01 单位（≈7px），无需补偿。
    exact: 'CH0335_Victory_Start_Random',
    patterns: [/victory[_\s-]?start[_\s-]?random/i],
    loop: false,
    startSeconds: 0.3,
    maxSeconds: 2.05,
    fadeInSeconds: 0.18,
    fadeOutSeconds: 0.45,
  },
  greet: {
    // ADR 0041 D3：**资产里没有"挥手"**。44 段逐段普查：没有任何正面片段的
    // 手抬到肩以上（唯一的"双手举过头"是 `Vital_Retreat`/`Vital_Death`，都是侧身/背身
    // 的撤退与倒地）；正面家族里"手抬到胸肩"的只有本段 0–2.4s 的摊手与
    // `Victory_Start` 的合手鞠躬。
    // 所以 `greet` 沿用这段"抬手摊开"的开头 0–2.2s —— 它是资产里最接近"举手打招呼"
    // 的正面动作；真正的鞠躬交给 `nod`。
    exact: 'CH0335_Cafe_Reaction',
    patterns: [/cafe[_\s-]?reaction/i, /reaction/i],
    loop: false,
    startSeconds: 0.15,
    maxSeconds: 2.2,
    fadeInSeconds: 0.2,
    fadeOutSeconds: 0.35,
  },
  nod: {
    // ADR 0041 D3：`nod` 不再只有程序化"低头 0.26rad"——`Cafe_Reaction` 的 8.7–9.9s
    // 就是一段真的鞠躬（9.4s 到最低点、10.0s 起身）。裁 1.2s（契约 §4.4 的上限），
    // 尾巴那半段"起身"由 0.3s 的交叉淡入补完。
    exact: 'CH0335_Cafe_Reaction',
    patterns: [/cafe[_\s-]?reaction/i, /reaction/i],
    loop: false,
    startSeconds: 8.7,
    maxSeconds: 9.9,
    fadeInSeconds: 0.16,
    fadeOutSeconds: 0.3,
  },
  happy: {
    // 正面胜利起势：双手合在胸前、微微鞠躬再抬头（开心/小庆祝）
    exact: 'CH0335_Victory_Start',
    patterns: [/victory[_\s-]?start(?!.*(random|interaction))/i],
    loop: false,
    fadeInSeconds: 0.2,
    fadeOutSeconds: 0.35,
  },

  // ---- 侧向战斗片段（只登记，默认不接线）----
  attack: {
    exact: 'CH0335_Normal_Attack_Start',
    patterns: [/normal[_\s-]?attack[_\s-]?start/i],
    loop: false,
  },
  skill: {
    exact: 'CH0335_Exs',
    patterns: [/^CH0335_Exs$/i, /exs(?!.*(cutin|prop))/i],
    loop: false,
  },
  panic: {
    exact: 'CH0335_Vital_Panic',
    patterns: [/vital[_\s-]?panic/i],
    loop: false,
  },
  down: {
    exact: 'CH0335_Vital_Death',
    patterns: [/vital[_\s-]?death/i],
    loop: false,
  },
  revive: {
    exact: 'CH0335_Vital_Retreat',
    patterns: [/vital[_\s-]?retreat/i],
    loop: false,
  },
};

export type SelectionReason = 'exact' | 'pattern' | 'missing';

export interface RoleSelection {
  role: ClipRole;
  /** 实际命中的片段名（模型原始名）；缺失为 null */
  name: string | null;
  reason: SelectionReason;
  pattern: string | null;
  /** 首选名（日志用） */
  preferred: string;
  loop: boolean;
}

export function selectRole(clips: readonly THREE.AnimationClip[], role: ClipRole): RoleSelection {
  const rule = CLIP_RULES[role];
  if (clips.some((clip) => clip.name === rule.exact)) {
    return {
      role,
      name: rule.exact,
      reason: 'exact',
      pattern: null,
      preferred: rule.exact,
      loop: rule.loop,
    };
  }
  for (const pattern of rule.patterns) {
    const hit = clips.find((clip) => pattern.test(clip.name));
    if (hit) {
      return {
        role,
        name: hit.name,
        reason: 'pattern',
        pattern: String(pattern),
        preferred: rule.exact,
        loop: rule.loop,
      };
    }
  }
  return {
    role,
    name: null,
    reason: 'missing',
    pattern: null,
    preferred: rule.exact,
    loop: rule.loop,
  };
}

/**
 * 按时间窗口裁片段（只保留 `start <= t <= end` 的关键帧，并把时间轴平移到 0）。
 *
 * 为什么不用 `AnimationUtils.subclip`：它按"帧号 × fps"切，模型片段的采样率
 * 并不统一（有的 30fps，有的 60fps），用时间切更稳，也不依赖 fps 假设。
 * 每个 track 至少保留 2 个关键帧，否则 three 求值会退化。
 */
export function trimClip(
  clip: THREE.AnimationClip,
  startSeconds = 0,
  endSeconds?: number,
): THREE.AnimationClip {
  const start = Math.max(0, startSeconds);
  const end = endSeconds && endSeconds > start ? endSeconds : clip.duration;
  if (start === 0 && end >= clip.duration) return clip;

  const tracks = clip.tracks.map((track) => {
    const times = track.times;
    if (times.length < 2) return track;
    const stride = track.values.length / times.length;

    let from = 0;
    while (from < times.length && times[from] < start) from += 1;
    let to = times.length;
    while (to > from && times[to - 1] > end) to -= 1;

    if (to - from < 2) {
      // 窗口落在关键帧间隙里：向两侧各借一帧，保证线性插值有意义
      from = Math.max(0, Math.min(from, times.length - 2));
      to = Math.min(times.length, from + 2);
    }
    if (from === 0 && to === times.length && start === 0) return track;

    const clone = track.clone();
    const slice = times.slice(from, to);
    clone.times = start > 0 ? slice.map((time) => time - start) : slice;
    clone.values = track.values.slice(from * stride, to * stride);
    return clone;
  });

  return new THREE.AnimationClip(`${clip.name}@${start}-${end}s`, end - start, tracks);
}

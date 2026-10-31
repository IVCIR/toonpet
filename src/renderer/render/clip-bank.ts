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

export type ClipRole =
  | 'idle'
  | 'idle.alt1'
  | 'held'
  | 'walk'
  | 'walk.carried'
  | 'pat'
  | 'greet'
  | 'happy'
  | 'victory'
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
}

/**
 * 角色 → 片段。`exact` 与 `patterns` 都对着模型原始名写，改模型只改这里。
 *
 * 每个 `exact` 后面的括号是实测结论（胶片条截图在 `tools/clip-preview/shots/`）。
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
  held: {
    // 拖拽时的"被拎着"：四肢垂着、身体蜷起来（0.2s 之后一直保持这个姿态）。
    // 注意 `Carrier_Idle` 其实是普通站姿，不是悬空姿态，只作降级候选。
    exact: 'CH0335_Formation_Pickup',
    patterns: [/formation[_\s-]?pickup/i, /carrier[_\s-]?idle/i, /pickup/i],
    loop: true,
  },
  walk: {
    // 正面行走循环；根骨无位移，走位由窗口/容器负责
    exact: 'CH0335_Cafe_Walk',
    patterns: [/cafe[_\s-]?walk/i, /carrier2?[_\s-]?walk/i, /move[_\s-]?ing/i],
    loop: true,
  },
  'walk.carried': {
    // 正面走、双手抱在胸前；比 Cafe_Walk 抬头，观感更自然，可作 walk 的替代
    exact: 'CH0335_Carrier2_Walk',
    patterns: [/carrier2?[_\s-]?walk/i],
    loop: true,
  },

  // ---- 一次性演出（正面）----
  pat: {
    // 10.75s 整身反应里的 3.5–6.6s：缩起身子、手放胸前，读作"害羞"。
    // 0–2.6s 是摊手手势（像"诶？"），不适合当摸头回应。
    exact: 'CH0335_Cafe_Reaction',
    patterns: [/cafe[_\s-]?reaction/i, /reaction/i],
    loop: false,
    startSeconds: 3.5,
    maxSeconds: 6.6,
  },
  greet: {
    // 同一段反应的开头 0–2.2s：正面、双手摊开，当"打招呼"用
    exact: 'CH0335_Cafe_Reaction',
    patterns: [/cafe[_\s-]?reaction/i, /reaction/i],
    loop: false,
    maxSeconds: 2.2,
  },
  happy: {
    // 正面胜利起势：双手合在胸前、微微鞠躬再抬头
    exact: 'CH0335_Victory_Start',
    patterns: [/victory[_\s-]?start(?!.*(random|interaction))/i],
    loop: false,
  },
  victory: {
    exact: 'CH0335_Victory_End',
    patterns: [/victory[_\s-]?end(?!.*(random|interaction))/i],
    loop: false,
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

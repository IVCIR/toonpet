/**
 * 官方表情差分的**固定文件名**（ADR 0026 D6）。
 *
 * 放在 shared 是因为两侧都要用：
 * - 主进程：`pet-asset://asset/expr/<file>` 只放行这里列出的名字（白名单，杜绝目录穿越）；
 * - 渲染进程：按 emotion 名字取对应贴图。
 *
 * 新增一张差分 = 改这个文件 + 放 PNG，不需要改协议实现。
 */
import type { EyeAssetKey } from '../renderer/render/emotion-face';

/** 眼型差分文件名。 */
export const EYE_ASSET_FILES: Record<EyeAssetKey, string> = {
  happy: 'eyes_happy.png',
  shy: 'eyes_shy.png',
  sad: 'eyes_sad.png',
  surprised: 'eyes_surprised.png',
};

/** 红晕差分文件名（半透明 PNG）。 */
export const BLUSH_ASSET_FILE = 'blush.png';

/**
 * 官方线稿贴花（ADR 0026 D7，**已否决**）。
 *
 * 保留常量只是为了文档可追溯：`Cafe_Idle` 动画自带眼皮骨骼平移（`bone_eye_D_*`），
 * 眨眼不需要任何贴花。这些文件仍在 `data/expressions/` 里作为储备，
 * 但**没有任何代码会读取它们**（不在 `EXPRESSION_FILES` 白名单内）。
 */
export const DECAL_FACE_FILES = {
  eyesClosed: 'eyes_closed.png',
  eyesHalf: 'eyes_half.png',
  mouthLine: 'mouth_line.png',
  mouthOpen: 'mouth_open.png',
  /** 官方遮罩转成的 alpha 图（白 = 盖住原生睁眼） */
  eyeMask: 'eye_mask_alpha.png',
} as const;

/** 协议放行的全部文件名。 */
export const EXPRESSION_FILES: readonly string[] = [
  ...Object.values(EYE_ASSET_FILES),
  BLUSH_ASSET_FILE,
];

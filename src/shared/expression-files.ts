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
 * 官方线稿贴花（ADR 0026 D7）：来自 `FX_TEX_CH0335_Img_Face_01.png` 的 3×3 线稿，
 * 由 `tools/` 的切图脚本按连通域裁出。贴花层只读这几张，不参与眼型 UV 合成。
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
  ...Object.values(DECAL_FACE_FILES),
  BLUSH_ASSET_FILE,
];

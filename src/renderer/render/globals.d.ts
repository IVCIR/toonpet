import type { PetShellApi } from '../../preload/main';
import type { RenderModule } from './render-module';
import type { MaskCapture } from './mask-capture';
import type { MeshMaterialFacts } from './material-diagnostics';
import type { ToonShadingDiagnostics } from './toon-shading';
import type { OutlineDiagnostics } from './outline';
import type { SpeechPlayerDiagnostics } from '../voice/speech-player';
import type { SubtitleCueSnapshot } from '../shell/subtitle-cue';

declare global {
  interface Window {
    /** 由 preload 通过 contextBridge 注入（见 src/preload/main.ts） */
    petShell: PetShellApi;
    /** 契约 §7.3 的 render 接口，供同页脚本与启动自检使用 */
    petRender: RenderModule;
    /** 内部：掩膜采集与 cmd:probe 应答，不属于 §7.3；不跨进程暴露 */
    petMask: MaskCapture;
    /** 内部：模型/骨骼/视线/呼吸/口型预留诊断，仅供自检与同页脚本（ADR 0009 D7.2） */
    petModel: {
      getDiagnostics(): ReturnType<RenderModule['getDiagnostics']>;
      /** ADR 0039 排查：头部带几何（掩膜 bbox / 22% 下边界 / 头骨位置） */
      headBandDiagnostics(): ReturnType<RenderModule['headBandDiagnostics']>;
    };
    /** 内部：语音播放侧诊断（包络电平/口型帧/AudioContext 状态；ADR 0015 D4） */
    petVoice: {
      getDiagnostics(): SpeechPlayerDiagnostics;
    };
    /** 内部：字幕时序诊断（pending / visible / failsafe；ADR 0021） */
    petSubtitle: {
      getDiagnostics(): SubtitleCueSnapshot;
    };
    /**
     * 内部：骨骼轴向标定（ADR 0035 D5，仅开发/自检用）。
     * pitch 绕世界 X、roll 绕世界 Z、yaw 绕世界 Y。
     */
    diagnostics: {
      listBones(): string[];
      setBone(name: string, yaw: number, pitch: number, roll: number): boolean;
      clear(): void;
      boneWorld(name: string): { x: number; y: number; z: number } | null;
      /** 阶段 14：手部发白诊断（只读网格/材质/贴图事实） */
      inspectMaterials(): MeshMaterialFacts[];
      /** 阶段 14：只把手/小臂顶点染色（红=手），证明手在哪块网格上 */
      tintSkin(scope: 'none' | 'hand' | 'both'): {
        meshes: number;
        handVertices: number;
        forearmVertices: number;
      };
      /** 阶段 14：整块 Body 材质换纯色（对照实验） */
      testHandMaterial(color?: number): { materialName: string; meshes: string[] } | null;
      /** ADR 0037：开/关全局光照 + Toon（关 = 修改前的无光照样子，截图 A/B 用） */
      setToon(enabled: boolean): ToonShadingDiagnostics;
      /** ADR 0038：开/关背面法描边（关 = 只隐藏描边壳，模型与材质不动） */
      setOutline(enabled: boolean): OutlineDiagnostics;
      /** ADR 0038 任务二：把光环临时换成 MeshToonMaterial（false 还原） */
      setHaloToon(enabled: boolean): { enabled: boolean; meshes: string[]; material: string | null };
      /** 阶段 14：恢复材质/顶点色 */
      resetMaterials(): void;
      /** 阶段 14：双手骨骼在内容区 CSS 坐标里的位置（截图取样） */
      handScreenPoints(): {
        left: { x: number; y: number } | null;
        right: { x: number; y: number } | null;
      } | null;
      /** ADR 0044：极轻的坐姿微动快照（张望/晃腿等；不触发面部贴图诊断） */
      sitMotion(): import('./sit-motion').SitMotionFrame | null;
      /** ADR 0047 取证：在 EyeMouth 贴图上叠绿色准星（true 开 / false 关） */
      eyeProbe(enabled: boolean): ReturnType<RenderModule['setEyeProbe']>;
      /** ADR 0047 取证：正交相机缩到脸上拍特写（0 = 关闭） */
      faceZoom(size: number): ReturnType<RenderModule['setFaceZoom']>;
      /** ADR 0048 D2：坐姿头部微调（rad，正 = 低头）。键盘 ↑/↓ 也走这里 */
      headTune(rad: number): number;
      /** ADR 0049 D1：微动作池的只读快照（idle / sitting，极轻，可 100ms 采样） */
      microPool(): ReturnType<RenderModule['microPoolDiagnostics']>;
      /** ADR 0049 D1（自检取证）：强制池条目（null = 解除） */
      forceMicroPool(pool: 'idle' | 'sit', kind: string | null): string | null;
      /** ADR 0049 D1（自检压缩时序）：覆盖池的切换间隔 */
      setMicroPoolInterval(pool: 'idle' | 'sit', minMs: number, maxMs: number): void;
      /** ADR 0050：待机静态站姿轮换的只读快照（当前角色 / 倒计时 / 候选池） */
      idleVariation(): import('./idle-variation').IdleVariationSnapshot;
      /** ADR 0050（自检取证）：强制下一个 tick 换到某个站姿（null = 解除） */
      forceIdleVariation(role: string | null): string | null;
      /** ADR 0050（自检压缩时序）：覆盖站姿轮换间隔 */
      setIdleVariationInterval(minMs: number, maxMs: number): void;
      /** ADR 0051：坐姿两段式的极轻快照（阶段 / 弹簧 / 头骨） */
      sitSequence(): import('./render-module').SitSequenceDiagnostics;
      /** ADR 0051（自检取证）：立刻把坐姿张望目标切到 camera / wander */
      forceSitGaze(kind: 'camera' | 'wander'): 'camera' | 'wander';
      /** ADR 0049 D2：视线三级阻尼的极轻快照（眼球 / 头部 / 躯干） */
      gaze(): ReturnType<RenderModule['gazeDiagnostics']>;
    };
  }
}

export {};

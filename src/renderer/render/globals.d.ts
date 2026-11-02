import type { PetShellApi } from '../../preload/main';
import type { RenderModule } from './render-module';
import type { MaskCapture } from './mask-capture';
import type { MeshMaterialFacts } from './material-diagnostics';
import type { ToonShadingDiagnostics } from './toon-shading';
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
      /** 阶段 14：恢复材质/顶点色 */
      resetMaterials(): void;
      /** 阶段 14：双手骨骼在内容区 CSS 坐标里的位置（截图取样） */
      handScreenPoints(): {
        left: { x: number; y: number } | null;
        right: { x: number; y: number } | null;
      } | null;
    };
  }
}

export {};

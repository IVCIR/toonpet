import type { PetShellApi } from '../../preload/main';
import type { RenderModule } from './render-module';
import type { MaskCapture } from './mask-capture';
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
  }
}

export {};

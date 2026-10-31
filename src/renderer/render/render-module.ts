/**
 * render 妯″潡锛堥樁娈?5锛夛細HFSM 涓夊眰 + 妯″瀷鑷甫鍔ㄧ敾 + 楠ㄩ浠茶 + 鎽稿ご/鎷栨嫿濮挎€併€? *
 * 濂戠害锛毬?.1锛堢姸鎬侀泦鍚堬級銆伮?.4锛坕ntent锛夈€伮?.1锝灺?.3锛堜笁灞備笌閫氶亾浼樺厛绾э級銆? * 搂7.3锛坔andleIntent / getState / modelReady锛夈€伮?1锛堢己澶遍檷绾э級锛? * ADR 0009锛堝姞杞?楠ㄩ/鍖呭洿鐩掞級銆丄DR 0010锛堟棤 blendshape 鐨勯潰閮ㄩ檷绾э級銆? * ADR 0014锛堥楠间徊瑁侀『搴忋€丮ixer 鎺ュ叆銆侀厤浠堕殣钘忋€乸at_react锛夈€? *
 * 姣忓抚鐨勫浐瀹氶『搴忥紙ADR 0014 D1锛夛細
 *   1. AnimationMixer.update
 *   2. BoneArbiter.beginFrame锛堟姄鍙栧姩鐢诲熀搴曪級
 *   3. 瑙嗙嚎鍙犲姞
 *   4. 鍙嶅簲鍙犲姞锛坧at_react 绛夛級
 *   5. BoneArbiter.endFrame锛堟瘡鏍瑰彈鎺ч楠煎彧鍐欎竴娆★級
 *   6. Physics 鏍瑰彉鎹紙鎽囨憜/浣嶇Щ锛夆啋 renderer.render
 */
import * as THREE from 'three';
import { DEFAULT_HIDE_ATTACHMENTS } from '../../shared/attachments';
import { MOUTH_FRAME_CLOSED, SETTLE_SQUASH_MS, SETTLE_SQUASH_RATIO } from '../../shared/constants';
import type { BroadcastEvent } from '../../shared/events';
import { isIntent } from '../../shared/intents';
import type { WalkCommand } from '../../shared/ipc';
import type { Bounds3 } from '../../shared/model-frame';
import { DEFAULT_FRAME_EXCLUDE } from '../../shared/model-frame';
import type { Emotion, Intent, RenderState } from '../../shared/types';
import type { BaseState, PhysicsState } from '../../shared/types';
import { createModelAnimations } from './animation-controller';
import type {
  ActionStatus,
  AnimationSlot,
  AnimationStatus,
  ModelAnimations,
  OneShotStatus,
} from './animation-controller';
import { createBoneArbiter } from './bone-arbiter';
import type { BoneArbiter } from './bone-arbiter';
import type { ClipRole } from './clip-bank';
import {
  EMOTION_FACE,
  EMOTION_FADE_MS,
  WALK_YAW_RAD,
  approach,
  fadeProgress,
  resolveMouthOwner,
  walkYawFor,
} from './emotion-face';
import type { BlushLevel, EmotionFace, EyeAssetKey, MouthOwner, MouthShape } from './emotion-face';
import { loadExpressionAssets } from './expression-assets';
import type { ExpressionAssets, PixelImage } from './expression-assets';
import { createFaceDecal } from './face-decal';
import type { FaceDecal, FaceDecalDiagnostics } from './face-decal';
import { DECAL_FACE_FILES } from '../../shared/expression-files';
import { collectFacialGeometry } from './facial-geometry';
import {
  CH0335_MOUTH_LAYOUT,
  createBlushChannel,
  createFacialChannel,
  loadMouthAtlas,
} from './facial-texture';
import type {
  BlushChannel,
  FacialChannel,
  FacialChannelDiagnostics,
  MouthLayer,
} from './facial-texture';
import { createGazeController } from './gaze';
import type { GazeController, GazeState } from './gaze';
import { createHfsm } from './hfsm';
import type { Hfsm, HfsmSnapshot, WalkPlan } from './hfsm';
import { createMaskCapture } from './mask-capture';
import type { MaskCapture } from './mask-capture';
import { loadModel, measureAnimatedMinY, placeModel } from './model-loader';
import type { LoadedModel } from './model-loader';
import { PAT_DURATION_MS, PAT_MOUTH_FRAME, patPose } from './pat-react';
import type { PatPose } from './pat-react';
import { createCapsulePlaceholder, PLACEHOLDER_BOTTOM_MARGIN_PX } from './placeholder';
import type { PlaceholderModel } from './placeholder';

/** 濂戠害 搂7.3 / 搂12锛氬悓涓€ intent 200ms 鍐呭彧鎵ц涓€娆°€?*/
export const INTENT_DEDUPE_MS = 200;

/** Base 鈫?Physics 鐨勪氦鍙夋贰鍏ワ紙ADR 0014 D3.2锛夈€?*/
const DRAG_IN_CROSSFADE_SECONDS = 0.25;
const DRAG_OUT_CROSSFADE_SECONDS = 0.3;
/** 琛岃蛋鐨勮繘鍑烘贰鍏ワ紙ADR 0024 D1锛夛細璧锋/鏀舵姣旀嫋鎷芥洿缂擄紝閬垮厤"鐬棿鍒囧Э鍔?銆?*/
const WALK_IN_FADE_SECONDS = 0.3;
const WALK_OUT_FADE_SECONDS = 0.35;
/** 鍥炲脊杩囩▼涓粠鎮┖濮挎€佹贰鍥?Idle锛圓DR 0024 D3锛夛細瑕佽鐩栨暣娈典笅钀斤紝涓嶈兘澶煭銆?*/
const SETTLE_FADE_SECONDS = 0.45;

/** 鎷栨嫿鏈熼棿鐨?鏁翠綋杞诲井鎽囨憜"涓?琚嫀璧?鎶崌锛堜笉鍐欓楠硷紝鍙浆/鎶?animationRoot锛夈€?*/
const DRAG_SWAY_PERIOD_S = 1.6;
const DRAG_SWAY_RAD = 0.05;
const DRAG_SWAY_RAMP_MS = 220;
const DRAG_LIFT_PX = 18;
const DRAG_LIFT_SMOOTHING = 12;

/** 鍢村瀷鍥鹃泦甯ф暟锛?脳8锛汸AT_MOUTH_FRAME 鐨?frameCount 鍙傛暟锛夈€?*/
const MOUTH_FRAME_COUNT = CH0335_MOUTH_LAYOUT.columns * CH0335_MOUTH_LAYOUT.rows;

/**
 * 琛岃蛋杞韩锛圓DR 0026 D1锛夛細`walking` 鏈熼棿鏁磋韩缁?Y 杞磋浆鍚戠Щ鍔ㄦ柟鍚戯紙卤90掳锛夛紝
 * 鍋滀笅骞虫粦鍥炴銆俙9 /s` 鐨勬寚鏁伴€艰繎 鈮?0.3s 璧板畬 96%锛岃捣姝?鏀舵鍚勮浆涓€娆°€? */
const WALK_TURN_RATE = 9;

/**
 * 琛ㄦ儏娣″叆鐨勯噺鍖栨鏁帮細鎶?250ms 鐨勬贰鍏ュ垏鎴?6 娆￠噸缁樸€? * 涓€娆￠噸缁樿鍐?10 涓囩骇璐村浘鍍忕礌锛圓DR 0026 D4.2锛夛紝姝ユ暟澶浼氬湪杩?250ms 閲岃繛缁帀甯с€? */
const EMOTION_FADE_STEPS = 6;

/** 琛ㄦ儏鍢村瀷鍦ㄥ簳鏉夸腑鐨勫搴?楂樺害姣斾緥锛堜笌 facial-texture 鐨勫父閲忎繚鎸佷竴鑷达級銆?*/
const EMOTION_MOUTH_ASPECT = 0.62 / 0.72;

interface ReactionSpec {
  durationMs: number;
  hopPx?: number;
  squash?: number;
  tilt?: number;
  /** 鎽嗗姩鍨嬶紙鎽囧ご锛夎€岄潪淇濇寔鍨嬶紙姝ご锛?*/
  oscillate?: boolean;
  look?: number;
}

interface PatState {
  pose: PatPose;
  progress: number;
}

/**
 * 闈?pat_react 鐨勭▼搴忓寲鍙嶅簲锛氬彧鐢ㄤ綅绉?缂╂斁/鏃嬭浆琛ㄨ揪锛屼笉寮曞叆鏂扮姸鎬佸悕鎴?intent銆? * pat_react 璧?pat-react.ts 鐨勪笁閫氶亾鍚堟垚锛堝ご閮ㄥ悗浠?+ 鍢村瀷锛夛紝涓嶅湪杩欓噷銆? */
const REACTIONS: Record<Exclude<Intent, 'none' | 'pat_react'>, ReactionSpec> = {
  greet: { durationMs: 700, hopPx: 18, look: 0.18 },
  nod: { durationMs: 380, squash: 0.06 },
  shake_head: { durationMs: 460, tilt: 0.13, oscillate: true },
  tilt_head: { durationMs: 1400, tilt: 0.2 },
  look_at_user: { durationMs: 600, look: 0.22 },
  happy_hop: { durationMs: 720, hopPx: 34 },
};

/** 鍔犺浇鎴愬姛浣嗙己灏戣繖浜涢楠兼椂锛屾寜 搂7.3 瑙嗕负"楠ㄩ缂哄け"鏁翠綋鍥為€€锛圓DR 0009 D6锛夈€?*/
const REQUIRED_BONES = ['head', 'eyeL', 'eyeR'] as const;

/**
 * 瀹樻柟鐗囨鎺ョ嚎琛紙ADR 0023 D2锛夈€? *
 * 鍙湁杩欓噷鍒楀嚭鐨?intent 浼氬皾璇曠敤妯″瀷鑷甫鐗囨锛涚墖娈电己澶辨椂鑷姩閫€鍥? * `REACTIONS` 鐨勭▼搴忓寲濮挎€侊紙ADR 0014 D6 鐨勮矾寰勪繚鐣欎负闄嶇骇鍒嗘敮锛夈€? * `nod` / `shake_head` / `tilt_head` / `look_at_user` 璧勪骇閲屾病鏈夊搴旂墖娈碉紝淇濇寔绋嬪簭鍖栥€? */
const INTENT_CLIP: Partial<Record<Intent, ClipRole>> = {
  greet: 'greet',
  happy_hop: 'happy',
};

/**
 * 寰呮満濮挎€佽疆鎹紙ADR 0023 D5锛夛細闀挎椂闂村彧鎾竴娈?Idle 浼氱湅鍑哄惊鐜€? * 榛樿鍙湪 `Cafe_Idle` 涓?`Formation_Idle` 涔嬮棿鎹紱`idle.alt2`锛圥ublic01锛? * 濮挎€佹洿"瀵瑰"锛屽厛涓嶉粯璁ゅ惎鐢紝棰勮纭鍚庡彲鍔犺繘鏉ャ€? */
const IDLE_VARIANT_ROLES: readonly ClipRole[] = ['idle', 'idle.alt1'];
const IDLE_VARIANT_MIN_MS = 22_000;
const IDLE_VARIANT_MAX_MS = 40_000;
const IDLE_VARIANT_FADE_SECONDS = 0.8;

export interface AnimationDiagnostics {
  clipCount: number;
  clips: string[];
  idle: { name: string | null; reason: string; preferred: string };
  held: { name: string | null; reason: string; preferred: string };
  walk: { name: string | null; reason: string; preferred: string };
  /** 璇箟瑙掕壊鐨勫懡涓粨鏋滐紙ADR 0023锛夛細missing 琛ㄧず璧勪骇閲屾病鏈夊搴旂墖娈?*/
  roles: Array<{
    role: ClipRole;
    name: string | null;
    reason: string;
    preferred: string;
    loop: boolean;
  }>;
  /** 姝ｅ湪鎾殑涓€娆℃€ф紨鍑猴紙null = 甯搁┗妲戒綅锛?*/
  oneShot: OneShotStatus | null;
  current: AnimationStatus;
  actions: ActionStatus[];
  groundCorrectionPx: number | null;
}

export interface PatDiagnostics {
  active: boolean;
  weight: number;
  allowMouthChange: boolean;
  mouthFrame: number | null;
}

export type { MouthOwner } from './emotion-face';

export interface FacialDiagnostics {
  /** `intent_resolved` 甯︽潵鐨?emotion锛堟湭鍙犲姞鎽稿ご鎶曞奖锛?*/
  emotion: Emotion;
  /** 瀹為檯鐢熸晥鐨?emotion锛堟懜澶存湡闂存姇褰变负 shy锛屄?.3锛?*/
  effective: Emotion;
  /** 璇?emotion 浣跨敤鐨勫畼鏂圭溂鍨嬪樊鍒嗛敭锛坣ull = 淇濇寔榛樿鐪硷紝闄嶇骇锛?*/
  eyes: EyeAssetKey | null;
  /** 璇?emotion 鐨勫槾鍨嬪浘鍏?*/
  mouthShape: MouthShape;
  mouthOwner: MouthOwner;
  blush: BlushLevel;
  /** 褰撳墠琛ㄦ儏灞傜殑涓嶉€忔槑搴︼紙0..1锛涙贰鍏ユ湡闂村湪涓よ€呬箣闂达級 */
  alpha: number;
  /** 娣″叆鏄惁浠嶅湪杩涜 */
  fading: boolean;
  /** 閲嶇粯娆℃暟涓庢渶杩戜竴娆¤€楁椂锛堟绉掞級 */
  repaints: number;
  lastRepaintMs: number | null;
  channel: FacialChannelDiagnostics | null;
  blushChannel: FacialChannelDiagnostics | null;
  /** 瀹樻柟琛ㄦ儏宸垎鐨勫姞杞芥儏鍐碉紙缂哄け鍗抽檷绾э紝涓嶉樆鏂級 */
  assets: {
    loadedEyes: EyeAssetKey[];
    blushLoaded: boolean;
    missing: string[];
    eyeImageLabel: string | null;
  };
}

export interface RenderDiagnostics {
  ready: boolean;
  loading: boolean;
  fallback: boolean;
  error: string | null;
  modelId: string | null;
  loadMs: number | null;
  frame: Bounds3 | null;
  scene: Bounds3 | null;
  pixelsPerUnit: number | null;
  content: { width: number; height: number };
  bones: { head: string | null; eyeL: string | null; eyeR: string | null; pelvis: string | null };
  hasMorphTargets: boolean;
  meshNames: string[];
  materialNames: string[];
  hiddenMeshes: string[];
  triangles: number;
  mouth: {
    materialName: string | null;
    sourceTexture: string | null;
    atlasLoaded: boolean;
    calibrated: boolean;
  };
  /** 琛ㄦ儏璐村浘鍚堟垚锛圓DR 0026锛夛細褰撳墠鍥惧厓銆佸彛鍨嬩紭鍏堢骇涓庝袱寮犺创鍥鹃€氶亾鐨勭姸鎬?*/
  facial: FacialDiagnostics;
  /** 瀹樻柟绾跨璐磋姳灞傦紙ADR 0026 D7锛夛紱null = 鏈惎鐢?*/
  decal: FaceDecalDiagnostics | null;
  gaze: GazeState;
  animation: AnimationDiagnostics | null;
  hfsm: HfsmSnapshot;
  /** 琛岃蛋 / 鍥炲脊锛圓DR 0024锛夛細Base 涓?Physics 鐨勭姸鎬併€佸綋鍓嶈璧拌鍒掋€佷笅娆¤皟搴﹀€掕鏃?*/
  motion: {
    base: BaseState;
    physics: PhysicsState | null;
    walking: WalkPlan | null;
    nextWalkInMs: number | null;
    /** 褰撳墠鏁磋韩鍋忚埅锛坮ad锛涜璧版椂 卤蟺/2锛岀珯瀹氫负 0锛夆€斺€擜DR 0026 D1 */
    walkYaw: number;
    walkYawTarget: number;
  };
  pat: PatDiagnostics;
  /** 璇煶鍙ｅ瀷锛圓DR 0015 D4锛夛細褰撳墠甯х敱娓叉煋渚ф挱鏀惧櫒鎸夊寘缁滄帹杩涳紝涓嶈法杩涚▼ */
  speech: { frame: number; driven: boolean };
  probePoints: { head: { x: number; y: number } | null; body: { x: number; y: number } | null };
}

export interface RenderModule {
  /** 鍛戒护锛氱珛鍗虫墽琛屽姩浣滄剰鍥俱€傛湭鐭ュ€奸檷绾?`none` 骞跺憡璀︼紙濂戠害 搂4.4銆伮?.3锛夈€?*/
  handleIntent(intent: string): void;
  /** 浜嬪疄鎷夊彇锛氬悓姝ヨ繑鍥烇紝涓嶅緱瑙﹀彂娓叉煋鎴?IO锛堝绾?搂7.3锛夈€?*/
  getState(): RenderState;
  resize(width: number, height: number): void;
  dispose(): void;
  /** 鍐呴儴锛歚cmd:probe` 鐨勫厜鏍囦綅缃紝鐢ㄤ簬瑙嗙嚎璺熼殢锛堜笉璺ㄨ繘绋嬫毚闇诧級 */
  setCursor(cssX: number, cssY: number, at?: number): void;
  /**
   * 鍐呴儴锛氭覆鏌撲晶璇煶鎾斁鍣ㄧ殑鍙ｅ瀷椹卞姩鍏ュ彛锛圓DR 0015 D4锛夈€?   * 涓嶅睘浜?搂7.3锛屼笉鏀?`RenderState`锛涘彧鎶婂抚鍙疯浆缁?`MouthChannel.setFrame`銆?   */
  setMouthFrame(frame: number): void;
  /** 鍐呴儴锛氫氦杩橀棴鍢村抚锛坄speech_ended` / 鎵撴柇鏃惰皟鐢級 */
  resetMouthFrame(): void;
  /**
   * 鍐呴儴锛歚evt:broadcast` 鐨勬覆鏌撲晶鍏ュ彛锛埪?.3 鐧藉悕鍗曞凡鐢?preload 鏍￠獙锛夈€?   * 鍙帴鍙?speech_* / drag_* / head_patted / intent_resolved锛涗笉灞炰簬 搂7.3 鐨勫叕鍏辨帴鍙ｃ€?   */
  handleEvent(event: BroadcastEvent): void;
  /** 鍐呴儴锛氳嚜妫€/璇婃柇鐢紙涓嶅睘浜?搂7.3 鐨?render 鍏叡鎺ュ彛锛?*/
  getDiagnostics(): RenderDiagnostics;
  /**
   * 鍐呴儴锛堥潪濂戠害锛夛細鏀硅璧拌皟搴﹂棿闅斻€傝嚜妫€鎶?20鈥?0s 鍘嬪埌 1.5鈥?s锛?   * 鍚﹀垯涓€娆¤嚜妫€绛変笉鍒拌皟搴﹁Е鍙戙€傜敓浜ц矾寰勪笉璋冪敤銆?   */
  setWalkInterval(minIntervalMs: number, maxIntervalMs: number): void;
}

export interface RenderModuleOptions {
  /** 鍙栨櫙鎺掗櫎姝ｅ垯锛堜笌涓昏繘绋嬪悓涓€浠斤紝缁?loadFile query 浼犲叆锛?*/
  frameExclude?: string;
  /** 瑁呴厤鏈熼厤浠堕殣钘忔鍒欙紙ADR 0014 D5锛涚己鐪佷笌鍙栨櫙鎺掗櫎鍚屾簮锛?*/
  hideAttachments?: string;
  /** 妯″瀷鏍囪瘑锛堟枃浠跺悕锛夛紝鐢ㄤ簬 `model_ready` */
  modelId?: string;
  /** 鍔犺浇鎴愬姛涓旈甯у凡娓叉煋鍚庡洖璋冧竴娆★紱鐢辨覆鏌撻〉璐熻矗鍙戝嚭 model_ready */
  onModelReady?: (payload: { modelId: string; loadMs: number }) => void;
  /**
   * ADR 0024 D5锛氭妸"瑕佸線鍝竟璧?杞垚 `cmd:walk`銆傜己鐪佹椂鍙挱鍔ㄧ敾涓嶅姩绐楀彛
   * 锛堥瑙堥〉/鍗曟祴鍦烘櫙锛夛紝涓嶅奖鍝?`walking` 鐘舵€佹湰韬€?   */
  onWalkRequest?: (command: WalkCommand) => void;
}

class StageRender implements RenderModule {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  /** Physics/Overlay 鐨勪綅绉讳笌鏃嬭浆鎸傚湪杩欓噷锛涘畠鐨勫師鐐?= 鍐呭鍖哄簳杈逛腑蹇冿紙鑴氬簳锛?*/
  private readonly animationRoot = new THREE.Group();
  private readonly options: RenderModuleOptions;

  private placeholder: PlaceholderModel | null;
  private model: LoadedModel | null = null;
  private animations: ModelAnimations | null = null;
  private arbiter: BoneArbiter | null = null;
  private readonly hfsm: Hfsm;
  /** 褰撳墠琛岃蛋璁″垝锛坄walking` 鏈熼棿闈炵┖锛涜瘖鏂笌鏀舵鐢級 */
  private walkingPlan: WalkPlan | null = null;
  private gaze: GazeController | null = null;
  /** EyeMouth 璐村浘閫氶亾锛氬畼鏂圭溂鍨嬪樊鍒?+ 琛ㄦ儏鍢村瀷 + 鍥惧眰浠茶鍚庣殑閲嶇粯锛圓DR 0026 D3/D6锛?*/
  private facial: FacialChannel | null = null;
  /** Face 璐村浘閫氶亾锛氱孩鏅曪紙涓庣溂鐫?鍢翠笉鏄悓涓€寮犺创鍥撅級 */
  private blushChannel: BlushChannel | null = null;
  /** 瀹樻柟琛ㄦ儏宸垎锛坄data/expressions/`锛夛紱缂哄け椤圭疆绌哄苟闄嶇骇锛屼笉闃绘柇 */
  private expressions: ExpressionAssets | null = null;
  private atlasLoaded = false;
  private emotion: Emotion = 'neutral';
  /** 琛ㄦ儏娣″叆璧风偣锛坄performance.now`锛夛紱涓婁竴甯х殑 emotion 鍙樺寲鏃堕噸缃?*/
  private emotionFadeStartedAt = 0;
  /** 涓婁竴娆″疄闄呯敓鏁堢殑 emotion锛堢敤鏉ュ垽鏂槸鍚﹂渶瑕侀噸鏂板紑濮嬫贰鍏ワ級 */
  private appliedEmotion: Emotion = 'neutral';
  private facialRepaints = 0;
  private facialLastRepaintMs: number | null = null;
  /** 鏈€杩戜竴娆￠噸缁樿鐩栫殑璐村浘鍍忕礌鏁帮紙璇婃柇锛氳瘉鏄庡彧鍔ㄥ眬閮ㄥ尯鍩燂級 */
  private facialLastPainted = 0;
  /** 涓婁竴娆￠噸缁樼殑鐘舵€佹寚绾癸紙閬垮厤鏃犲彉鍖栨椂閲嶅涓婁紶璐村浘锛?*/
  private facialKey = '';

  /** 瀹樻柟绾跨璐磋姳灞傦紙ADR 0026 D7锛夛細鐪ㄧ溂绾?+ 鍢寸嚎 + 鑵孩锛屾寕鍦ㄥご楠ㄤ笂 */
  private decal: FaceDecal | null = null;
  /** 涓嬩竴娆＄湪鐪肩殑鏃跺埢锛坄performance.now`锛?*/
  private nextBlinkAt = 0;
  /** 褰撳墠鐪ㄧ溂鍔ㄧ敾鐨勮捣鐐癸紱null = 涓嶅湪鐪ㄧ溂 */
  private blinkStartedAt: number | null = null;

  /** 鍐呴儴鎺ュ彛锛氭帺鑶滈噰闆嗭紙鐢?RenderBundle 鎸佹湁锛屼笉灞炰簬 搂7.3锛?*/
  readonly maskCapture: MaskCapture;

  private readonly startedAt = performance.now();
  private frameHandle: number | null = null;
  private width = 0;
  private height = 0;
  private lastFrameAt = performance.now();

  private readonly lastIntentAt = new Map<string, number>();
  /** 闈?pat_react 鐨勭▼搴忓寲鍙嶅簲锛堣瑙夛級锛屼笌 HFSM 鐨?reacting 鍚屾簮璁℃椂 */
  private reaction: { spec: ReactionSpec; startedAt: number } | null = null;
  private dragStartedAt: number | null = null;
  private dragging = false;
  private dragSwayGain = 0;
  private dragLiftPx = 0;
  private patMouthActive = false;
  /** 琛岃蛋杞韩鐨勫綋鍓?/ 鐩爣鍋忚埅锛坮ad锛孉DR 0026 D1锛?*/
  private walkYaw = 0;
  private walkYawTarget = 0;
  /** 鎽稿ご鏄惁鐢卞畼鏂规暣韬墖娈垫壙鎷咃紙true 鏃朵笉鍐嶅彔鍔犵▼搴忓寲澶撮儴鍋忕Щ锛孉DR 0023 D4锛?*/
  private officialPat = false;
  /** 涓嬩竴娆″緟鏈哄Э鎬佽疆鎹㈢殑鏃跺埢锛坧erformance.now 鍩哄噯锛?*/
  private idleVariantAt = 0;
  private idleVariantRole: ClipRole = 'idle';
  /** 璇煶鍙ｅ瀷锛圓DR 0015 D4锛夛細甯у彿鐢辨挱鏀惧櫒鎸夊寘缁滄帹杩?*/
  private lipSyncFrame = MOUTH_FRAME_CLOSED;
  private lipSyncDriven = false;

  /** Idle 濮挎€佷笅鍙缃戞牸鐨勬渶浣庣偣锛坮oot 灞€閮ㄥ崟浣嶏級锛沶ull = 鏈牎姝?*/
  private groundMinYLocal: number | null = null;

  private ready = false;
  private loading = true;
  private error: string | null = null;
  private readyPending = false;

  constructor(canvas: HTMLCanvasElement, options: RenderModuleOptions = {}) {
    this.options = options;
    this.hfsm = createHfsm({ patDurationMs: PAT_DURATION_MS });

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      // 濂戠害 搂3.3 R-2 / 搂3.6 P-2锛氱姝㈠紑鍚?preserveDrawingBuffer
      preserveDrawingBuffer: false,
    });
    this.renderer.setClearColor(0x00000000, 0);
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    this.camera.position.z = 100;

    this.scene.add(this.animationRoot);

    this.placeholder = createCapsulePlaceholder();
    this.animationRoot.add(this.placeholder.group);

    this.maskCapture = createMaskCapture({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
    });
    this.maskCapture.start();

    this.frameHandle = requestAnimationFrame(this.handleFrame);
    void this.loadRealModel();
  }

  private async loadRealModel(): Promise<void> {
    try {
      const loaded = await loadModel({
        modelId: this.options.modelId ?? 'model',
        frameExclude: this.options.frameExclude ?? DEFAULT_FRAME_EXCLUDE,
        hideAttachments: this.options.hideAttachments ?? DEFAULT_HIDE_ATTACHMENTS,
        contentHeight: Math.max(1, this.height),
      });

      const missing = REQUIRED_BONES.filter((key) => !loaded.bones[key]);
      if (missing.length > 0) {
        loaded.dispose();
        throw new Error(
          `楠ㄩ缂哄け锛?{missing.join(', ')}锛埪?.3锛歮odelReady=false锛屽洖閫€鍗犱綅鑳跺泭浣擄級`,
        );
      }

      this.model = loaded;

      if (this.placeholder) {
        this.animationRoot.remove(this.placeholder.group);
        this.placeholder.dispose();
        this.placeholder = null;
      }
      this.animationRoot.add(loaded.root);
      this.applyPlacement();

      this.setupAnimations(loaded);
      this.calibrateGround();

      this.arbiter = createBoneArbiter();
      for (const bone of [loaded.bones.head, loaded.bones.eyeL, loaded.bones.eyeR]) {
        if (bone) this.arbiter.register(bone);
      }
      this.gaze = createGazeController(loaded.bones);

      this.ready = true;
      this.readyPending = true;
      this.error = null;

      console.log(
        `[render] 妯″瀷宸插姞杞?modelId=${loaded.modelId} loadMs=${Math.round(loaded.loadMs)} ` +
          `meshes=${loaded.meshNames.length} triangles=${loaded.triangleCount} ` +
          `morphTargets=${String(loaded.hasMorphTargets)} ` +
          `bones=head:${String(Boolean(loaded.bones.head))},eyeL:${String(Boolean(loaded.bones.eyeL))},` +
          `eyeR:${String(Boolean(loaded.bones.eyeR))},pelvis:${String(Boolean(loaded.bones.pelvis))} ` +
          `hidden=${loaded.hiddenMeshes.join('|') || '(none)'} ` +
          `ppm=${Math.round(loaded.pixelsPerUnit)}`,
      );

      void this.attachFacialChannel();
      void this.attachFaceDecal();
    } catch (error) {
      this.error = String(error);
      this.ready = false;
      // 搂7.3 / 搂11锛氭ā鍨嬬己澶?瑙ｆ瀽澶辫触/楠ㄩ缂哄け 鈫?鍗犱綅鑳跺泭浣擄紝涓嶇櫧灞忋€佷笉鎶涘紓甯?      console.warn('[render] 妯″瀷鍔犺浇澶辫触锛屽洖閫€鍗犱綅鑳跺泭浣擄紙搂7.3/搂11锛?, error);
    } finally {
      this.loading = false;
    }
  }

  /** 鏋氫妇 44 娈靛姩鐢?+ 閫変腑 idle/held/walk + 璧锋挱 Idle锛圓DR 0014 D3锛夈€?*/
  private setupAnimations(model: LoadedModel): void {
    const animations = createModelAnimations(model.root, model.animations);
    this.animations = animations;

    console.log(`[render] 妯″瀷鑷甫鍔ㄧ敾 ${animations.clipNames.length} 娈碉細${animations.clipNames.join(', ')}`);
    const selection = animations.selection;
    const hasClip = (name: string): string => (animations.clipNames.includes(name) ? name : '(none)');
    console.log(
      `[render] 鍔ㄧ敾閫夋嫨 idle=${String(selection.idle.name)}(${selection.idle.reason}) ` +
        `held=${String(selection.held.name)}(${selection.held.reason}) ` +
        `walk=${String(selection.walk.name)}(${selection.walk.reason}锛涙湰杞彧璇嗗埆銆佷笉鍚敤)`,
    );
    console.log(
      `[render] 鍔ㄤ綔瑙掕壊璇嗗埆锛歱ickup=${hasClip('CH0335_Formation_Pickup')}锛堣鎷庤捣锛宧eld 鐨勯檷绾у€欓€夛級 ` +
        `struggle=${hasClip('CH0335_Vital_Panic')}锛堟專鎵庯紝held 鐨勯檷绾у€欓€夛級`,
    );
    for (const slot of ['idle', 'held', 'walk'] as AnimationSlot[]) {
      if (selection[slot].reason === 'missing') {
        console.warn(`[render] 鏈壘鍒?${slot} 鐗囨锛堥閫?${selection[slot].preferred}锛夛紝璇ユЫ浣嶄繚鎸佺┖杞琡);
      }
    }

    // ADR 0023锛氭妸璇箟瑙掕壊鐨勫懡涓粨鏋滃叏閮ㄦ墦鍑烘潵锛屾帴绾挎槸鍚︾敓鏁堜竴鐪煎彲瑙?    const roleReport = Object.values(animations.roles)
      .map((role) => `${role.role}=${role.name ?? '(missing)'}${role.reason === 'pattern' ? '(pattern)' : ''}`)
      .join(' ');
    console.log(`[render] 璇箟瑙掕壊锛?{roleReport}`);

    if (!animations.play('idle', 0)) {
      console.warn('[render] Idle 鐗囨缂哄け锛欱ase 灞傛病鏈夊姩鐢婚┍鍔紙ADR 0014 D3锛?);
      return;
    }
    this.idleVariantRole = 'idle';
    this.scheduleIdleVariant(performance.now());
    // 璁╅甯у姩浣滄潈閲嶇敓鏁堬紝闅忓悗鎵嶈兘鍋氬湴闈㈡牎姝ｇ殑钂欑毊閲囨牱
    animations.update(0);
    model.root.updateMatrixWorld(true);
  }

  /**
   * ADR 0014 D4锛氳嚜甯﹀姩鐢荤殑鏍归骞崇Щ鎶婅鑹蹭粠缁戝畾濮挎€佹姮璧凤紙瀹炴祴绾?22px锛夛紝
   * 杩欓噷鎸?Idle 濮挎€佸仛涓€娆?CPU 钂欑毊閲囨牱锛屾妸鏈€浣庣偣瀵归綈鍐呭鍖哄簳杈广€?   */
  private calibrateGround(): void {
    const model = this.model;
    if (!model) return;
    const minY = measureAnimatedMinY(model.root, model.meshes);
    if (minY === null || !Number.isFinite(minY)) {
      console.warn('[render] 鍦伴潰鏍℃閲囨牱澶辫触锛屼繚鐣欑粦瀹氬Э鎬佹斁缃紙ADR 0014 D4锛?);
      return;
    }
    const beforePx = model.root.position.y;
    this.groundMinYLocal = minY;
    this.applyPlacement();
    const afterPx = model.root.position.y;
    console.log(
      `[render] 鍦伴潰鏍℃ minY=${minY.toFixed(6)} 鍗曚綅 rootY ${beforePx.toFixed(1)} 鈫?${afterPx.toFixed(1)}px ` +
        `(${(afterPx - beforePx).toFixed(1)}px)`,
    );
  }

  /**
   * 闈㈤儴璐村浘閫氶亾锛圓DR 0026锛夛細鎶婂畼鏂圭溂鍨嬪樊鍒?+ 鍢磋创鍒?`EyeMouth`銆佹妸绾㈡檿璐村埌 `Face`銆?   *
   * 涓ゅ紶璐村浘鏄袱涓潗璐紝鎵€浠ユ槸涓ゆ潯閫氶亾锛涜〃鎯呭眰鐨?鐢ㄥ摢寮犲浘"鐢?`applyFacial` 鍐冲畾锛?   * 杩欓噷鍙礋璐ｈ閰嶃€佷竴娆℃€ф爣瀹氾紙涓夎褰?鈫?闈㈢┖闂磋〃闈級涓庡樊鍒嗛杞姐€?   */
  private async attachFacialChannel(): Promise<void> {
    const mouthTarget = this.model?.mouthMaterial ?? null;
    if (!mouthTarget) {
      console.warn('[render] 鏈壘鍒?EyeMouth 鏉愯川锛屽彛鍨?琛ㄦ儏涓嶅彲鐢紙搂11 璁板綍涓€娆″憡璀︼級');
      return;
    }
    const geometry = this.model ? collectFacialGeometry(this.model) : null;
    const [atlas, expressions] = await Promise.all([loadMouthAtlas(), loadExpressionAssets()]);
    this.atlasLoaded = Boolean(atlas);
    this.expressions = expressions;

    if (geometry?.mouth) {
      this.facial = createFacialChannel({
        material: geometry.mouth.material,
        sourceTexture: geometry.mouth.sourceTexture,
        triangles: geometry.mouth.triangles,
        skinColor: this.model?.skinColor ?? null,
        atlas,
      });
    } else {
      // 搂11锛氭病鏈夊彲鐢ㄥ嚑浣曟椂閫€鍥?鍙湁鍢淬€佹病鏈夌溂鍨?绾㈡檿"鐨勬棫璺緞锛堜粛鐒朵笉鐧藉睆锛?      this.facial = createFacialChannel({
        material: mouthTarget,
        sourceTexture: this.model?.mouthSourceTexture ?? null,
        triangles: [],
        skinColor: this.model?.skinColor ?? null,
        atlas,
      });
    }

    if (geometry?.face) {
      this.blushChannel = createBlushChannel({
        material: geometry.face.material,
        sourceTexture: geometry.face.sourceTexture,
        triangles: geometry.face.triangles,
        skinColor: this.model?.skinColor ?? null,
        eyes: this.facial.eyes,
      });
    }

    const mouthDiag = this.facial.diagnostics();
    console.log(
      `[render] 闈㈤儴璐村浘閫氶亾 material=${String(mouthDiag.materialName)} ` +
        `atlasLoaded=${String(this.atlasLoaded)} calibrated=${String(mouthDiag.calibrated)} ` +
        `eyeCalibrated=${String(mouthDiag.eyeCalibrated)} ` +
        `eyes=${mouthDiag.eyes.map((eye) => `${eye.x.toFixed(5)}/${eye.y.toFixed(5)}`).join('|') || '(none)'} ` +
        `blush=${String(this.blushChannel?.calibrated ?? false)} ` +
        `expressions=${Object.keys(expressions.eyes).join(',') || '(none)'} ` +
        `missing=${expressions.missing.join('|') || '(none)'}`,
    );

    // 棣栧抚鎶婇潤鎬侀棴鍢?+ 褰撳墠 emotion 鐢讳笂鍘伙紙涓嶆敼鍙?鏈敹鍒版儏缁椂鏄?neutral"鐨勮涔夛級
    this.applyFacial(performance.now(), true);
  }

  /**
   * 瀹樻柟绾跨璐磋姳灞傦紙ADR 0026 D7锛夈€?   *
   * 绾跨鏉ヨ嚜 `FX_TEX_CH0335_Img_Face_01.png`锛堝畼鏂圭粰 3D 灏忎汉鍋氳〃鎯呯敤鐨?3脳3 绾跨锛夛紝
   * 鎸傚湪澶撮涓嬨€佸弬涓庢繁搴︽祴璇曪紝鍥犳闅忓姩鐢昏蛋涓斾細琚垬娴锋纭伄鎸°€?   * 璐村浘缂哄け鏃舵暣灞備笉鐢熸晥锛屽彧璁颁竴鏉?WARN锛埪?1锛夈€?   */
  private async attachFaceDecal(): Promise<void> {
    const model = this.model;
    if (!model) return;

    const load = async (file: string): Promise<HTMLImageElement | null> => {
      try {
        const image = new Image();
        image.src = `pet-asset://asset/expr/${file}`;
        await image.decode();
        return image;
      } catch {
        return null;
      }
    };
    const [eyesClosed, mouthLine, mouthOpen] = await Promise.all([
      load(DECAL_FACE_FILES.eyesClosed),
      load(DECAL_FACE_FILES.mouthLine),
      load(DECAL_FACE_FILES.mouthOpen),
    ]);

    if (!eyesClosed && !mouthLine) {
      console.warn('[render] 闈㈤儴绾跨璐村浘缂哄け锛岃创鑺卞眰涓嶅惎鐢紙搂11锛?);
      return;
    }

    this.decal = createFaceDecal({
      headBone: model.bones.head,
      root: model.root,
      meshes: model.meshes,
      assets: { eyesClosed, mouthLine, mouthOpen, blush: null },
    });
    this.scheduleBlink(performance.now());

    const diag = this.decal.diagnostics();
    console.log(
      `[render] 闈㈤儴璐磋姳 ready=${String(diag.ready)} eyePlanes=${diag.eyePlanes} ` +
        `mouth=${String(diag.mouth)} blush=${String(diag.blush)} ` +
        `eyeCenter=${diag.eyeCenter?.map((value) => value.toFixed(6)).join(',') ?? '(none)'} ` +
        `reason=${diag.reason ?? '-'}`,
    );
  }

  /** 鐪ㄧ溂闂撮殧 2.6鈥?s锛堥殢鏈猴紝閬垮厤鏈烘鎰燂級銆?*/
  private scheduleBlink(now: number): void {
    this.nextBlinkAt = now + 2600 + Math.random() * 3400;
  }

  /** 姣忓抚鎺ㄨ繘鐪ㄧ溂锛氫笁瑙掑寘缁?0鈫?鈫?锛屾€绘椂闀?140ms銆?*/
  private updateBlink(now: number): void {
    const decal = this.decal;
    if (!decal) return;

    if (this.blinkStartedAt === null) {
      if (now < this.nextBlinkAt) {
        decal.update();
        return;
      }
      this.blinkStartedAt = now;
    }

    decal.setBlink(1); this.decal?.update(); return;
    const elapsed = now - this.blinkStartedAt;
    const duration = 140;
    if (elapsed >= duration) {
      decal.setBlink(0);
      this.blinkStartedAt = null;
      this.scheduleBlink(now);
    } else {
      const progress = elapsed / duration;
      decal.setBlink(progress < 0.5 ? progress * 2 : (1 - progress) * 2);
    }
    decal.update();
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.camera.left = -this.width / 2;
    this.camera.right = this.width / 2;
    this.camera.top = this.height / 2;
    this.camera.bottom = -this.height / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setSize(this.width, this.height, false);
    this.animationRoot.position.y = -this.height / 2;
    this.applyPlacement();
  }

  private applyPlacement(): void {
    if (this.model) {
      this.model.pixelsPerUnit = placeModel(this.model.root, this.model.frame, this.height);
      // 鍦伴潰鏍℃锛圓DR 0014 D4锛夛細鏈€浣庣偣瀵归綈鍐呭鍖哄簳杈癸紱鏈牎姝ｆ椂鐢ㄧ粦瀹氬Э鎬?      if (this.groundMinYLocal !== null) {
        this.model.root.position.y = -this.groundMinYLocal * this.model.pixelsPerUnit;
      }
    } else if (this.placeholder) {
      this.placeholder.group.position.set(0, PLACEHOLDER_BOTTOM_MARGIN_PX, 0);
    }
  }

  handleIntent(intent: string): void {
    if (!isIntent(intent)) {
      // 濂戠害 搂4.4锛氶檷绾т负 none锛屽啓鍛婅锛屼笉鎶涘紓甯搞€佷笉闅忔満鎾埆鐨勫姩浣?      console.warn(`[render] 鏈煡 intent "${String(intent)}"锛屽凡闄嶇骇涓?none锛堝绾?搂4.4锛塦);
      return;
    }
    if (intent === 'none') return;

    // ADR 0024 D3锛氬洖寮规湡闂翠笉鎺ュ彈鏂扮殑鍔ㄤ綔鎰忓浘锛堝敮涓€渚嬪鏄噸鏂版嫋鎷斤紝璧?drag_started锛?    if (this.hfsm.snapshot().physics === 'settling') {
      console.log(`[render] settling 鏈熼棿蹇界暐 intent=${intent}锛圓DR 0024 D3锛塦);
      return;
    }

    const now = performance.now();
    const last = this.lastIntentAt.get(intent) ?? Number.NEGATIVE_INFINITY;
    if (now - last < INTENT_DEDUPE_MS) return;
    this.lastIntentAt.set(intent, now);

    if (intent === 'pat_react') {
      // 涓?head_patted 鍚屼竴鏉″弽搴旇矾寰勶紙搂4.4锛氫綆鏉冮噸娣峰悎锛屼笉寰楁墦鏂彛鍨嬶級
      this.hfsm.intent(now, intent, PAT_DURATION_MS);
      console.log('[render] pat_react锛坕ntent 鍛戒护锛夆啋 reacting');
      return;
    }

    const spec = REACTIONS[intent];
    if (!spec) return;
    // ADR 0023 D2锛氭湁瀹樻柟鐗囨灏辨暣韬挱锛屾病鏈夊氨閫€鍥炵▼搴忓寲浣嶇Щ/缂╂斁
    const role = INTENT_CLIP[intent];
    const played = role ? this.playOfficial(role, 'idle', `intent ${intent}`) : false;
    const clipMs = played ? this.oneShotDurationMs() : 0;
    this.reaction = played ? null : { spec, startedAt: now };
    this.hfsm.intent(now, intent, clipMs > 0 ? clipMs : spec.durationMs);
  }

  /**
   * 鍐呴儴锛歚evt:broadcast` 鐨勬覆鏌撲晶鍏ュ彛銆傚绾?搂7.3 鐨勮闃呴泦鍚堬細
   * speech_*锛堝彛鍨嬪眰锛屾湰杞彧璺熼殢鐘舵€侊級銆乨rag_*锛圥hysics锛夈€乭ead_patted锛堜綆鏉冮噸 pat_react锛夈€?   * intent_resolved锛堝彧鍙?emotion锛夈€?   */
  handleEvent(event: BroadcastEvent): void {
    const now = performance.now();
    switch (event.name) {
      case 'speech_started': {
        const payload = event.payload as { utteranceId: string };
        this.hfsm.speechStarted(now, payload.utteranceId);
        // 搂5.2锛氬彛鍨嬮€氶亾浼樺厛绾ф渶楂樸€傝璇濅竴寮€濮嬪氨绔嬪埢浜よ繕鍢村瀷锛屼笉绛変笅涓€甯с€?        this.lipSyncDriven = true;
        this.applyFacial(now, true);
        console.log(`[render] speaking 寮€濮?utteranceId=${payload.utteranceId}锛堝彛鍨嬬敱鍖呯粶椹卞姩锛孉DR 0015 D4锛塦);
        break;
      }
      case 'speech_ended': {
        const payload = event.payload as { utteranceId: string; reason: string };
        this.hfsm.speechEnded(now);
        // 璇村畬/琚墦鏂?澶辫触閮借闂槾锛岄伩鍏?璇村畬寮犵潃鍢?锛圓DR 0015 D4.5锛?        this.resetMouthFrame();
        console.log(`[render] speaking 缁撴潫 utteranceId=${payload.utteranceId} reason=${payload.reason}`);
        break;
      }
      case 'head_patted': {
        const payload = event.payload as { patCount: number };
        // ADR 0024 D3锛氬洖寮规湡闂翠笉鎺ュ彈鏂扮殑鎽稿ご锛堥噸鏂版嫋鎷介櫎澶栵級
        if (this.hfsm.snapshot().physics === 'settling') {
          console.log('[render] settling 鏈熼棿蹇界暐 head_patted锛圓DR 0024 D3锛?);
          break;
        }
        const speaking = this.hfsm.snapshot().speakingUtteranceId !== null;
        // 搂5.3 / ADR 0023 D4锛氳璇濇湡闂存暣韬墖娈典細璁╀綅缁欏彛鍨嬮€氶亾锛岄€€鍥炵▼搴忓寲鎽稿ご
        const played = !speaking && this.playOfficial('pat', 'idle', 'head_patted');
        this.officialPat = played;
        const clipMs = played ? this.oneShotDurationMs() : 0;
        this.hfsm.headPatted(now, clipMs > 0 ? clipMs : undefined);
        console.log(
          `[render] head_patted 鈫?reacting patCount=${payload.patCount}` +
            `锛?{played ? '瀹樻柟鐗囨' : '绋嬪簭鍖?}锛塦,
        );
        break;
      }
      case 'drag_started': {
        // 搂4.1锛歚walking` 鐨勯€€鍑烘潯浠朵箣涓€鏄鎷栨嫿鎵撴柇鈥斺€斿厛璁╃獥鍙ｅ仠姝ワ紝鍐嶈繘 dragged
        this.stopWalk('drag_started');
        // 琚嫀璧锋潵鏃朵笉鍐嶄繚鎸佽璧版湞鍚戯紙ADR 0026 D1.3锛?        this.walkYawTarget = 0;
        this.hfsm.dragStarted(now);
        this.dragStartedAt = now;
        this.dragging = true;
        // held 鐩存帴灏辨槸"琚嫀鐫€"鐨勬偓绌哄Э鎬侊紙clip-bank: Formation_Pickup 寰幆锛夛紝
        // 涓嶅啀鍗曠嫭鎾?pickup 璧峰娍锛岄伩鍏嶅悓涓€娈靛姩鐢昏繛鎾袱娆★紙ADR 0023 D3锛?        this.playAnimation('held', DRAG_IN_CROSSFADE_SECONDS, 'drag_started');
        break;
      }
      case 'drag_released': {
        // D-6 / ADR 0024 D3锛氭澗鎵嬪厛杩涘叆 settling锛屽洖寮硅繃绋嬩腑娣″洖 Idle
        this.hfsm.dragReleased(now);
        this.dragging = false;
        this.walkYawTarget = 0;
        this.playAnimation('idle', SETTLE_FADE_SECONDS, 'drag_released 鈫?settling锛堝洖寮逛腑锛?);
        break;
      }
      case 'motion_ended': {
        const payload = event.payload as { kind?: unknown; reason?: unknown };
        const reason = typeof payload.reason === 'string' ? payload.reason : 'unknown';
        if (payload.kind === 'walk') {
          this.walkingPlan = null;
          // 鍋滀笅鍗宠浆鍥炴闈紙ADR 0026 D1.2锛?          this.walkYawTarget = 0;
          this.hfsm.walkEnded(now);
          this.playAnimation('idle', WALK_OUT_FADE_SECONDS, `motion_ended(walk,${reason})`);
          break;
        }
        if (payload.kind === 'settle') {
          this.hfsm.settleEnded(now);
          // 钀藉湴缂撳啿锛氭瀬鐭殑涓嬭共锛圓DR 0024 D3锛夛紝涓嶅弬涓庣獥鍙ｄ綅绉?          this.reaction = {
            spec: { durationMs: SETTLE_SQUASH_MS, squash: SETTLE_SQUASH_RATIO },
            startedAt: now,
          };
          console.log(`[render] 鍥炲脊缁撴潫锛?{reason}锛夆啋 钀藉湴缂撳啿 ${SETTLE_SQUASH_MS}ms`);
        }
        break;
      }
      case 'intent_resolved': {
        const payload = event.payload as { emotion: Emotion };
        const previous = this.emotion;
        this.emotion = payload.emotion;
        // 搂5.2锛氭柊 emotion 浠?0.25s 娣″叆锛坄applyFacial` 鍐呰鏃讹級
        this.applyFacial(now, true);
        if (previous !== payload.emotion) {
          const face = EMOTION_FACE[payload.emotion] ?? EMOTION_FACE.neutral;
          const eyeLoaded = face.eyes ? this.expressions?.eyes[face.eyes] !== undefined : false;
          const eyeLabel = face.eyes ? `${face.eyes}:${eyeLoaded ? 'loaded' : 'missing'}` : '-';
          console.log(
            `[render] emotion ${previous} 鈫?${payload.emotion} ` +
              `锛坋yes=${eyeLabel} mouth=${face.mouth} blush=${face.blush}锛塦,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  private playAnimation(slot: AnimationSlot, fadeSeconds: number, reason: string): void {
    if (!this.animations) return;
    const ok = this.animations.play(slot, fadeSeconds);
    const current = this.animations.current();
    if (ok) {
      console.log(`[render] 鍔ㄤ綔鍒囨崲 ${reason} 鈫?${slot}=${String(current.name)}锛坈rossFade ${fadeSeconds}s锛塦);
    } else {
      console.warn(`[render] 鍔ㄤ綔鍒囨崲澶辫触 ${reason} 鈫?${slot}锛堢墖娈电己澶憋紝淇濇寔褰撳墠鍔ㄤ綔锛塦);
    }
  }

  /**
   * ADR 0023锛氫紭鍏堟挱瀹樻柟鐗囨銆?   * 杩斿洖 false 琛ㄧず璧勪骇閲屾病鏈夊搴旂墖娈碉紝璋冪敤鏂瑰簲閫€鍥炵▼搴忓寲闄嶇骇璺緞銆?   */
  private playOfficial(role: ClipRole, returnTo: AnimationSlot, reason: string): boolean {
    const animations = this.animations;
    if (!animations) return false;
    const ok = animations.playOnce(role, { returnTo });
    const one = animations.oneShot();
    if (ok) {
      console.log(
        `[render] 瀹樻柟鐗囨 ${reason} 鈫?${role}=${String(one?.name)}` +
          `锛?{one ? one.duration.toFixed(2) : '?'}s锛屾挱瀹屽洖 ${returnTo}锛塦,
      );
    } else {
      console.log(`[render] 瀹樻柟鐗囨缂哄け ${reason} 鈫?${role}锛岃蛋绋嬪簭鍖栭檷绾);
    }
    return ok;
  }

  /** 涓€娆℃€х墖娈电殑鏃堕暱锛堟绉掞級锛涚敤浜庤 HFSM 鐨?reacting 涓庡姩鐢诲悓瀵垮懡銆?*/
  private oneShotDurationMs(): number {
    const one = this.animations?.oneShot();
    return one ? one.duration * 1000 : 0;
  }

  /** ADR 0023 D5锛氭帓涓嬩竴娆″緟鏈哄Э鎬佽疆鎹€?*/
  private scheduleIdleVariant(now: number): void {
    const span = IDLE_VARIANT_MAX_MS - IDLE_VARIANT_MIN_MS;
    this.idleVariantAt = now + IDLE_VARIANT_MIN_MS + Math.random() * span;
  }

  /** ADR 0023 D5锛氬湪寰呮満濮挎€佷箣闂翠氦鍙夋贰鍏ワ紝閬垮厤闀挎椂闂寸湅鍑哄惊鐜€?*/
  private rotateIdleVariant(now: number): void {
    this.scheduleIdleVariant(now);
    const animations = this.animations;
    if (!animations || IDLE_VARIANT_ROLES.length < 2) return;
    const candidates = IDLE_VARIANT_ROLES.filter((role) => role !== this.idleVariantRole);
    if (candidates.length === 0) return;
    const role = candidates[Math.floor(Math.random() * candidates.length)];
    if (animations.playRole(role, IDLE_VARIANT_FADE_SECONDS, 'idle')) {
      this.idleVariantRole = role;
      console.log(`[render] 寰呮満濮挎€佽疆鎹?鈫?${role}=${String(animations.roles[role].name)}`);
    }
  }

  /**
   * ADR 0024 D1锛氳繘鍏?`walking`銆?   * 浣嶇Щ**涓嶄娇鐢ㄥ姩鐢婚噷鐨?root motion**鈥斺€旂獥鍙ｄ綅缃敱 `cmd:walk` 浜ょ粰 shell 鐨勭函鍑芥暟鐗╃悊锛?   * 杩欓噷鍙礋璐ｆ崲鍔ㄤ綔涓庤褰曡鍒掞紝閬垮厤"鍔ㄧ敾鎺ㄧ潃绐楀彛婕傜Щ"銆?   */
  private beginWalk(plan: WalkPlan, now: number): void {
    this.walkingPlan = plan;
    // ADR 0026 D1锛氳捣韬氨杞悜绉诲姩鏂瑰悜锛埪?0掳锛夛紝鐢?`updateFrame` 鎸囨暟閫艰繎
    this.walkYawTarget = walkYawFor(plan.direction);
    this.scheduleIdleVariant(now);
    const played = this.animations?.playRole('walk', WALK_IN_FADE_SECONDS, 'walk') ?? false;
    this.options.onWalkRequest?.({
      phase: 'start',
      direction: plan.direction,
      distancePx: plan.distancePx,
    });
    console.log(
      `[render] walking 寮€濮?direction=${plan.direction} distance=${plan.distancePx}px ` +
        `clip=${played ? String(this.animations?.roles.walk.name) : '(缂哄け锛屽師鍦颁笉鍔?'}`,
    );
  }

  /** 鏀舵锛氳姹?shell 鍋滀笅锛屽苟娣″洖 Idle锛堝埌杈?/ 鎾炶竟 / 琚嫋鎷芥墦鏂兘璧拌繖閲岋級銆?*/
  private stopWalk(reason: string): void {
    if (!this.walkingPlan) return;
    this.walkingPlan = null;
    // ADR 0026 D1.2锛氬仠涓嬪嵆杞洖姝ｉ潰
    this.walkYawTarget = 0;
    this.options.onWalkRequest?.({ phase: 'stop' });
    this.playAnimation('idle', WALK_OUT_FADE_SECONDS, `stopWalk(${reason})`);
  }

  getState(): RenderState {
    const snapshot = this.hfsm.snapshot();
    const pat = this.patState(performance.now());
    return {
      base: snapshot.base,
      overlay: snapshot.overlay,
      physics: snapshot.physics,
      // 搂5.3 / 搂4.5锛氳鎽稿ご鏈熼棿涓存椂鎶曞奖涓?shy锛岀粨鏉熷悗鍥炲埌 intent_resolved 鐨?emotion
      emotion: pat ? 'shy' : this.emotion,
      speakingUtteranceId: snapshot.speakingUtteranceId,
      // 濂戠害 搂7.1锛?.3.0 / ADR 0008锛夛細Orch.idle = 缂栨帓灞傛病鏈夊湪閫旇瘽璇€?      orchestrator: 'idle',
      // 搂7.3锛氬彧鏈夌湡瀹炴ā鍨嬪姞杞芥垚鍔燂紙涓斿叧閿楠奸綈鍏級鎵嶆槸 ready锛涘惁鍒欏崰浣嶈兌鍥婁綋
      modelReady: this.ready,
    };
  }

  setCursor(cssX: number, cssY: number, at: number = performance.now()): void {
    this.gaze?.setCursor(cssX, cssY, at);
  }

  /** 鍐呴儴锛堥潪濂戠害锛夛細鑷鎶?20鈥?0s 鐨勮皟搴﹂棿闅斿帇鍒?1.5鈥?s锛岃 搂16.2 鐨勮嚜妫€璇存槑銆?*/
  setWalkInterval(minIntervalMs: number, maxIntervalMs: number): void {
    if (!Number.isFinite(minIntervalMs) || !Number.isFinite(maxIntervalMs)) return;
    if (minIntervalMs <= 0 || maxIntervalMs < minIntervalMs) return;
    this.hfsm.setWalkSchedule({ minIntervalMs, maxIntervalMs }, performance.now());
    console.log(`[render] 琛岃蛋璋冨害闂撮殧鏀逛负 ${minIntervalMs}鈥?{maxIntervalMs}ms锛堣嚜妫€鐢級`);
  }

  /**
   * 璇煶鍙ｅ瀷锛氬彧鎺ュ彈 0..甯ф暟-1锛岄噸澶嶅抚涓嶉噸缁橈紙ADR 0010 鐨?鈮?0Hz 棰勭畻鐢辨挱鏀惧櫒淇濊瘉锛夈€?   * 鍙ｅ瀷閫氶亾浼樺厛绾ф渶楂橈紙搂5.2锛夛細`applyFacial` 閲屽彛鍨嬪眰姘歌繙鍘嬭繃琛ㄦ儏灞傦紙ADR 0026 D3锛夈€?   */
  setMouthFrame(frame: number): void {
    const count = MOUTH_FRAME_COUNT;
    const clamped = Math.max(0, Math.min(count - 1, Math.round(frame)));
    if (clamped === this.lipSyncFrame && this.lipSyncDriven) return;
    this.lipSyncFrame = clamped;
    this.lipSyncDriven = true;
    this.applyFacial(performance.now());
  }

  resetMouthFrame(): void {
    this.lipSyncFrame = MOUTH_FRAME_CLOSED;
    this.lipSyncDriven = false;
    this.applyFacial(performance.now());
  }

  /**
   * 琛ㄦ儏灞傜殑鍞竴瑁呴厤鐐癸紙ADR 0026 D3/D6锛夛細鍏堟寜 搂5.2 鐨勯€氶亾浼樺厛绾х畻鍑?鍢寸敱璋佽礋璐?锛?   * 鍐嶆妸瀹樻柟鐪煎瀷宸垎 / 鍢村瀷 / 绾㈡檿浜ょ粰涓ゆ潯璐村浘閫氶亾銆傜姸鎬佹棤鍙樺寲鏃朵笉閲嶇粯銆?   */
  private applyFacial(now: number, force = false): void {
    const facial = this.facial;
    if (!facial) return;

    const state = this.resolveFacialState(now);
    const key = [
      state.face.eyes ?? '-',
      state.face.mouth,
      state.face.blush,
      state.eyeReady ? 'eye' : 'noeye',
      state.blushReady ? 'blush' : 'noblush',
      state.owner,
      state.layer.kind === 'atlas' ? `a${state.layer.frame}/${state.layer.frameCount}` : state.layer.kind,
      state.alpha.toFixed(3),
    ].join('|');

    if (!force && key === this.facialKey) return;
    this.facialKey = key;

    const startedAt = performance.now();
    facial.setEyes(state.eyeImage, state.alpha);
    facial.setMouth(state.layer);
    const painted = facial.repaint();
    this.blushChannel?.setBlush(state.blushImage, state.face.blush, state.blushAlpha);
    const blushPainted = this.blushChannel?.repaint() ?? 0;
    this.facialRepaints += 1;
    this.facialLastRepaintMs = performance.now() - startedAt;
    this.facialLastPainted = painted + blushPainted;
  }

  /**
   * 閫氶亾浠茶锛堢函璁＄畻锛屼笉鏀圭姸鎬侊級锛氬彛鍨?> 鎽稿ご > 琛ㄦ儏 > 闈欐€侀棴鍢达紙搂5.2 / 搂5.3锛夈€?   * 琛ㄦ儏娣″叆杩涘害涔熷湪杩欓噷绠楋紙搂5.2 鐨?0.25s锛夈€?   */
  private resolveFacialState(now: number): {
    effective: Emotion;
    face: EmotionFace;
    owner: MouthOwner;
    layer: MouthLayer;
    alpha: number;
    blushAlpha: number;
    eyeImage: PixelImage | null;
    blushImage: PixelImage | null;
    eyeReady: boolean;
    blushReady: boolean;
  } {
    const snapshot = this.hfsm.snapshot();
    const pat = this.patState(now);
    const effective: Emotion = pat ? 'shy' : this.emotion;
    const face = EMOTION_FACE[effective] ?? EMOTION_FACE.neutral;

    if (effective !== this.appliedEmotion) {
      this.appliedEmotion = effective;
      this.emotionFadeStartedAt = now;
    }
    const progress = fadeProgress(now - this.emotionFadeStartedAt, EMOTION_FADE_MS);
    const quantized = Math.round(progress * EMOTION_FADE_STEPS) / EMOTION_FADE_STEPS;
    // neutral 娌℃湁鍥惧厓锛屾贰鍏ョ郴鏁版棤鎰忎箟锛堢洿鎺ュ洖鍒伴潤鎬佸簳鍥撅級
    const alpha = effective === 'neutral' ? 1 : quantized;

    const speaking = snapshot.speakingUtteranceId !== null;
    const owner = resolveMouthOwner({
      speaking,
      lipSyncDriven: this.lipSyncDriven,
      patActive: pat !== null && pat.pose.allowMouthChange,
      emotionMouth: face.mouth,
      alpha,
    });
    let layer: MouthLayer;
    if (owner === 'lip-sync') {
      layer = { kind: 'atlas', frame: this.lipSyncFrame, frameCount: MOUTH_FRAME_COUNT };
    } else if (owner === 'pat') {
      layer = { kind: 'atlas', frame: PAT_MOUTH_FRAME, frameCount: MOUTH_FRAME_COUNT };
    } else if (owner === 'emotion') {
      layer = { kind: 'glyph', shape: face.mouth };
    } else {
      layer = { kind: 'static' };
    }
    this.patMouthActive = owner === 'pat';

    // 瀹樻柟宸垎缂哄け 鈫?璇ュ眰缃┖锛堥檷绾э細鍙彉鍢村瀷銆佷繚鎸侀粯璁ょ溂 / 涓嶅彔绾㈡檿锛?    const eyeImage = face.eyes ? this.expressions?.eyes[face.eyes] ?? null : null;
    const blushImage = this.expressions?.blush ?? null;

    return {
      effective,
      face,
      owner,
      layer,
      alpha,
      blushAlpha: face.blush > 0 ? alpha : 0,
      eyeImage,
      blushImage,
      eyeReady: eyeImage !== null,
      blushReady: blushImage !== null && face.blush > 0,
    };
  }

  private facialDiagnostics(now: number, pat: PatState | null): FacialDiagnostics {
    // 鍙锛氳繖閲屼笉鍚姩娣″叆璁℃椂锛岄伩鍏嶈瘖鏂皟鐢ㄦ敼鍙樿涓?    const effective: Emotion = pat ? 'shy' : this.emotion;
    const face = EMOTION_FACE[effective] ?? EMOTION_FACE.neutral;
    const alpha =
      effective === 'neutral'
        ? 1
        : fadeProgress(now - this.emotionFadeStartedAt, EMOTION_FADE_MS);
    return {
      emotion: this.emotion,
      effective,
      eyes: face.eyes,
      mouthShape: face.mouth,
      mouthOwner: resolveMouthOwner({
        speaking: this.hfsm.snapshot().speakingUtteranceId !== null,
        lipSyncDriven: this.lipSyncDriven,
        patActive: this.patMouthActive,
        emotionMouth: face.mouth,
        alpha,
      }),
      blush: face.blush,
      alpha: Number(alpha.toFixed(3)),
      fading: alpha < 0.999 && effective !== 'neutral',
      repaints: this.facialRepaints,
      lastRepaintMs:
        this.facialLastRepaintMs === null ? null : Number(this.facialLastRepaintMs.toFixed(2)),
      channel: this.facial?.diagnostics() ?? null,
      blushChannel: this.blushChannel?.diagnostics() ?? null,
      assets: {
        loadedEyes: Object.keys(this.expressions?.eyes ?? {}) as EyeAssetKey[],
        blushLoaded: Boolean(this.expressions?.blush),
        missing: this.expressions?.missing ?? [],
        eyeImageLabel: this.facial?.eyeImageLabel ?? null,
      },
    };
  }


  getDiagnostics(): RenderDiagnostics {
    const model = this.model;
    const now = performance.now();
    const snapshot = this.hfsm.snapshot();
    const pat = this.patState(now);

    const gaze = this.gaze?.state() ?? {
      yaw: 0,
      pitch: 0,
      targetYaw: 0,
      targetPitch: 0,
      idle: true,
      submitted: false,
    };

    const animations = this.animations;
    const animation: AnimationDiagnostics | null = animations
      ? {
          clipCount: animations.clipNames.length,
          clips: animations.clipNames,
          idle: {
            name: animations.selection.idle.name,
            reason: animations.selection.idle.reason,
            preferred: animations.selection.idle.preferred,
          },
          held: {
            name: animations.selection.held.name,
            reason: animations.selection.held.reason,
            preferred: animations.selection.held.preferred,
          },
          walk: {
            name: animations.selection.walk.name,
            reason: animations.selection.walk.reason,
            preferred: animations.selection.walk.preferred,
          },
          roles: Object.values(animations.roles).map((role) => ({
            role: role.role,
            name: role.name,
            reason: role.reason,
            preferred: role.preferred,
            loop: role.loop,
          })),
          oneShot: animations.oneShot(),
          current: animations.current(),
          actions: animations.actions(),
          groundCorrectionPx:
            model && this.groundMinYLocal !== null
              ? Number((-this.groundMinYLocal * model.pixelsPerUnit).toFixed(1))
              : null,
        }
      : null;

    return {
      ready: this.ready,
      loading: this.loading,
      fallback: !this.ready,
      error: this.error,
      modelId: model?.modelId ?? null,
      loadMs: model?.loadMs ?? null,
      frame: model?.frame ?? null,
      scene: model?.scene ?? null,
      pixelsPerUnit: model?.pixelsPerUnit ?? null,
      content: { width: this.width, height: this.height },
      bones: {
        head: model?.bones.head?.name ?? null,
        eyeL: model?.bones.eyeL?.name ?? null,
        eyeR: model?.bones.eyeR?.name ?? null,
        pelvis: model?.bones.pelvis?.name ?? null,
      },
      hasMorphTargets: model?.hasMorphTargets ?? false,
      meshNames: model?.meshNames ?? [],
      materialNames: model?.materialNames ?? [],
      hiddenMeshes: model?.hiddenMeshes ?? [],
      triangles: model?.triangleCount ?? 0,
      mouth: {
        materialName: model?.mouthMaterialName ?? null,
        sourceTexture: model?.mouthSourceTexture?.name ?? null,
        atlasLoaded: this.atlasLoaded,
        calibrated: this.facial?.calibrated ?? false,
      },
      facial: this.facialDiagnostics(now, pat),
      decal: this.decal?.diagnostics() ?? null,
      gaze,
      animation,
      hfsm: snapshot,
      motion: {
        base: snapshot.base,
        physics: snapshot.physics,
        walking: this.walkingPlan,
        nextWalkInMs:
          this.hfsm.nextWalkAt === null
            ? null
            : Math.max(0, Math.round(this.hfsm.nextWalkAt - now)),
        walkYaw: Number(this.walkYaw.toFixed(4)),
        walkYawTarget: Number(this.walkYawTarget.toFixed(4)),
      },
      pat: {
        active: pat !== null,
        weight: pat?.pose.weight ?? 0,
        allowMouthChange: pat?.pose.allowMouthChange ?? true,
        mouthFrame: this.patMouthActive ? PAT_MOUTH_FRAME : 0,
      },
      speech: {
        frame: this.lipSyncFrame,
        driven: this.lipSyncDriven,
      },
      probePoints: this.computeProbePoints(),
    };
  }

  /**
   * 鑷鐢ㄧ殑鎺㈤拡鐐癸紙涓嶆槸鐢熶骇璺緞锛夛細
   * - head锛氬彇鏅寘鍥寸洅椤堕儴寰€涓?17%锛堣惤鍦?R-10 鎺╄啘澶撮儴甯﹀唴锛岄伩寮€澶撮《杈圭紭锛夛紱
   * - body锛氫紭鍏堢敤 Pelvis 楠ㄩ鐨勪笘鐣屼綅缃紝缂哄け鏃堕€€鍥炲彇鏅寘鍥寸洅 45% 楂樺害銆?   */
  private computeProbePoints(): {
    head: { x: number; y: number } | null;
    body: { x: number; y: number } | null;
  } {
    const model = this.model;
    if (!model) return { head: null, body: null };

    const frame = model.frame;
    const frameHeight = Math.max(1e-9, frame.maxY - frame.minY);
    const pixelsPerUnit = model.pixelsPerUnit;
    const headUnitY = frame.maxY - frameHeight * 0.17;
    const headY = this.height - (headUnitY - frame.minY) * pixelsPerUnit;
    const centerX = this.width / 2;

    let bodyY = this.height - (frame.minY + frameHeight * 0.45) * pixelsPerUnit;
    if (model.bones.pelvis) {
      model.root.updateMatrixWorld(true);
      const world = new THREE.Vector3();
      model.bones.pelvis.getWorldPosition(world);
      bodyY = this.height / 2 - world.y;
    }

    return {
      head: { x: centerX, y: headY },
      body: { x: centerX, y: bodyY },
    };
  }

  dispose(): void {
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
    this.maskCapture.stop();
    this.animations?.dispose();
    this.arbiter?.reset();
    this.gaze?.dispose();
    this.facial?.dispose();
    this.blushChannel?.dispose();
    this.model?.dispose();
    this.placeholder?.dispose();
    this.renderer.dispose();
  }

  private handleFrame = (): void => {
    const now = performance.now();
    this.updateFrame(now);
    this.renderer.render(this.scene, this.camera);

    // 棣栧抚娓叉煋瀹屾垚鍚庡啀鍙?model_ready锛埪?.3锛?鍔犺浇瀹屾垚涓旈甯у彲娓叉煋"锛?    if (this.readyPending && this.model) {
      this.readyPending = false;
      const payload = { modelId: this.model.modelId, loadMs: this.model.loadMs };
      this.options.onModelReady?.(payload);
      console.log(
        `[render] model_ready modelId=${payload.modelId} loadMs=${Math.round(payload.loadMs)}`,
      );
    }

    this.frameHandle = requestAnimationFrame(this.handleFrame);
  };

  private patState(now: number): PatState | null {
    const snapshot = this.hfsm.snapshot();
    const reaction = snapshot.reaction;
    if (!reaction) return null;
    const isPat = reaction.kind === 'head_patted' || reaction.intent === 'pat_react';
    if (!isPat) return null;
    const progress = (now - reaction.startedAt) / reaction.durationMs;
    if (progress >= 1) return null;
    const speaking = snapshot.speakingUtteranceId !== null;
    return { pose: patPose(progress, speaking), progress };
  }

  private updateFrame(now: number): void {
    const dt = Math.min(100, Math.max(0, now - this.lastFrameAt)) / 1000;
    this.lastFrameAt = now;

    // HFSM锛氫竴娆℃€у弽搴旀寜鏃堕暱鑷剤 + Base 灞傝璧拌皟搴︼紙搂4.1 / ADR 0024 D1锛?    const hfsmTick = this.hfsm.tick(now);
    if (hfsmTick.startWalk) this.beginWalk(hfsmTick.startWalk, now);

    // ADR 0023锛氬畼鏂圭墖娈垫槸鍚︽鍦ㄦ壙鎷呮懜澶达紙鏄垯涓嶅啀鍙犲姞绋嬪簭鍖栧ご閮ㄥ亸绉伙級
    const oneShot = this.animations?.oneShot() ?? null;
    this.officialPat = oneShot?.role === 'pat';

    // ADR 0023 D5锛氱┖闂叉椂杞崲寰呮満濮挎€侊紙鎷栨嫿銆佽璧颁笌涓€娆℃€ф紨鍑烘湡闂翠笉鎹級
    const hfsmSnapshot = this.hfsm.snapshot();
    if (
      !this.dragging &&
      !oneShot &&
      hfsmSnapshot.base === 'idle' &&
      hfsmSnapshot.physics === null &&
      now >= this.idleVariantAt
    ) {
      this.rotateIdleVariant(now);
    }

    // 1) AnimationMixer锛圓DR 0014 D1锛氬叏甯у彧鍏佽鍦ㄨ繖閲?update锛?    this.animations?.update(dt);

    // 2) 楠ㄩ浠茶锛氭姄鍙栨湰甯у姩鐢诲熀搴曞苟娓呴浂鍙犲姞閲?    this.arbiter?.beginFrame();

    // 3) 瑙嗙嚎閫氶亾鍙犲姞锛堝悎鎴愬湪鍔ㄧ敾濮挎€佷箣涓婏紝鑰屼笉鏄鐩栫粦瀹氬Э鎬侊級
    if (this.gaze && this.arbiter) {
      this.gaze.update(now, this.width, this.height, this.arbiter);
    }

    // 4) 鍙嶅簲閫氶亾鍙犲姞锛坧at_react 鐨勫ご閮ㄥ悗浠?渚у€撅級
    const pat = this.patState(now);
    const head = this.model?.bones.head ?? null;
    // 瀹樻柟鐗囨鑷繁浼氬姩澶?鍔ㄨ韩浣擄紝绋嬪簭鍖栧悗浠般€佷晶鍊俱€佸墠鍊惧彧鍦ㄩ檷绾ц矾寰勫彔鍔狅紙ADR 0023 D4锛?    if (pat && head && this.arbiter && !this.officialPat) {
      this.arbiter.add(head, 0, pat.pose.headPitch, pat.pose.headRoll);
    }
    this.applyFacial(now);

    // 5) 鍐欏洖鏈€缁堝洓鍏冩暟锛堟瘡鏍瑰彈鎺ч楠煎彧鍐欎竴娆★級
    this.arbiter?.endFrame();

    // 6) Physics / 鍙嶅簲鏍瑰彉鎹?    let hop = 0;
    let tilt = 0;
    let look = 0;
    let squash = 0;

    if (this.reaction) {
      const { spec, startedAt } = this.reaction;
      const progress = (now - startedAt) / spec.durationMs;
      if (progress >= 1) {
        this.reaction = null;
      } else {
        const envelope = Math.sin(Math.PI * progress);
        hop += (spec.hopPx ?? 0) * envelope;
        squash += (spec.squash ?? 0) * envelope;
        if (spec.tilt) {
          tilt += spec.oscillate
            ? spec.tilt * Math.sin(progress * Math.PI * 6) * envelope
            : spec.tilt * envelope;
        }
        look += (spec.look ?? 0) * envelope;
      }
    }

    const draggingTarget = this.dragging ? 1 : 0;
    const liftTarget = this.dragging ? DRAG_LIFT_PX : 0;
    const smooth = 1 - Math.exp(-DRAG_LIFT_SMOOTHING * dt);
    this.dragSwayGain += (draggingTarget - this.dragSwayGain) * smooth;
    this.dragLiftPx += (liftTarget - this.dragLiftPx) * smooth;

    const sway = this.dragSway(now);
    // ADR 0026 D1锛氳璧版湞鍚?= 鐩爣鍋忚埅鐨勬寚鏁伴€艰繎锛涘仠涓嬭嚜鍔ㄥ洖姝ｏ紙`walkYawTarget = 0`锛?    this.walkYaw = approach(this.walkYaw, this.walkYawTarget, dt, WALK_TURN_RATE);
    this.animationRoot.position.y = -this.height / 2 + hop - this.dragLiftPx;
    this.animationRoot.rotation.z =
      tilt + sway + (this.officialPat ? 0 : (pat?.pose.bodyLean ?? 0));
    // 杞韩涓?`look` 鍙嶅簲鍏辩敤鍚屼竴涓?Y 杞撮€氶亾锛氬彔鍔犺€屼笉鏄簰鐩歌鐩?    this.animationRoot.rotation.y = look + this.walkYaw;
    this.animationRoot.scale.set(1, 1 - squash, 1);

    // 璐磋姳灞傛渶鍚庢洿鏂帮細姝ゆ椂楠ㄩ濮挎€佸凡瀹氾紝璐磋姳璺熺潃澶撮璧帮紙ADR 0026 D7锛?    this.updateBlink(now);
  }

  /** 鎷栨嫿鏈熼棿鐨勮交寰憞鎽嗭紙ADR 0014 D3 / 鏈疆"鍙互鏁翠綋杞诲井鎽囨憜"锛夈€?*/
  private dragSway(now: number): number {
    if (this.dragStartedAt === null || this.dragSwayGain <= 0.001) return 0;
    const elapsedMs = Math.max(0, now - this.dragStartedAt);
    const ramp = Math.min(1, elapsedMs / DRAG_SWAY_RAMP_MS);
    const phase = (elapsedMs / 1000 / DRAG_SWAY_PERIOD_S) * Math.PI * 2;
    return Math.sin(phase) * DRAG_SWAY_RAD * ramp * this.dragSwayGain;
  }
}

/** 娓叉煋渚т竴娆″垱寤轰袱涓璞★細搂7.3 鐨勫叕鍏辨帴鍙ｏ紝浠ュ強鍐呴儴鐨勬帺鑶滈噰闆嗗櫒銆?*/
export interface RenderBundle {
  module: RenderModule;
  mask: MaskCapture;
}

export function createRenderModule(
  canvas: HTMLCanvasElement,
  options: RenderModuleOptions = {},
): RenderBundle {
  const instance = new StageRender(canvas, options);
  return { module: instance, mask: instance.maskCapture };
}


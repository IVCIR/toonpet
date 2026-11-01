/**
 * 前台应用归一化（ADR 0032 D1）：把"窗口标题 + 类名"压成**有限个标准类别**。
 *
 * 为什么需要它（ADR 0030 遗留的负面项）：段 3.5 之前直接把 `GetWindowTextW` 的原始标题
 * 塞进提示词，于是 `report-final.docx - Word`、`如何治疗xxx - Google 搜索` 这类**用户内容**
 * 会跟着提示词一起进模型。虽然只发往本机 `127.0.0.1:11434`，但"她只需要知道你在写代码，
 * 不需要知道文件名"是更小的隐私面，也是更省 token、对小模型更稳定的输入。
 *
 * 设计约束：
 * - **纯函数**：不读时钟、不碰 Win32、不 import Electron，可在 Node 里直接穷举单测；
 * - **只做规则匹配**：没有模型、没有词表文件、没有网络；命中不了就降级 `other: <类名>`；
 * - **类名不是用户内容**：`Chrome_WidgetWin_1`、`CASCADIA_HOSTING_WINDOW_CLASS` 是应用
 *   自己注册的窗口类，不含用户的文档名/页面标题，因此降级用它而不是用标题。
 *
 * 匹配顺序 = 优先级（命中即返回），顺序本身是行为的一部分，`app-normalizer.test.ts` 逐条锁死：
 *
 *   game → video → meeting → coding → browser → other
 *
 * 为什么 video 在 browser 之前：`YouTube - Google Chrome` 既是浏览器页面也是"在看视频"，
 * 后者对她更有用（"你在看视频"比"你在用浏览器"更像在观察你）。
 * 为什么 game 在最前：游戏窗口常带浏览器内核类名（`Chrome_WidgetWin_1`），先认游戏不会误判。
 */
import { PRESENCE_TITLE_MAX_CHARS } from '../../shared/constants';
import type { AppCategory, KnownAppCategory } from '../../shared/world-types';

/**
 * 一张规则表：`text` 只匹配**标题**，`classes` 精确匹配**类名**（小写）。
 *
 * 两者分开而不是拼成一个串，是因为 `cursor\s*$` 这类锚定在末尾的规则一旦拼上类名就永远不命中。
 * 标题与类名各管一半，职责更清楚：标题说"这是什么应用"，类名说"这是谁注册的窗口"。
 */
interface CategoryRule {
  category: KnownAppCategory;
  /** 关键词/正则：只匹配标题（小写、已清洗） */
  text: RegExp;
  /** 仅当类名精确等于其中一项时命中（只有类名可靠的场合） */
  classes?: ReadonlyArray<string>;
}

/**
 * 规则表的唯一出处。改写规则 = 改行为，必须同步 `app-normalizer.test.ts` 与 ADR 0032。
 *
 * 注意：**不要**把 `chrome_widgetwin_1` 写进任何一条规则。它是 Chromium/Electron 的通用窗口类，
 * Chrome / Edge / VSCode / Cursor / Teams / Discord 全都是它——用它分类等于随机分类。
 */
const RULES: ReadonlyArray<CategoryRule> = [
  {
    category: 'game',
    text: /原神|genshin|崩坏|崩壊|honkai|ブルーアーカイブ|blue archive|蔚蓝档案|アークナイツ|明日方舟|arknights|星穹铁道|star rail|steam|epic games|battle\.net|league of legends|valorant|minecraft|elden ring|エルデンリング|fate\/grand|グラブル|アズールレーン|azur lane/iu,
    classes: ['unitywndclass', 'unrealwindow', 'sdl_app'],
  },
  {
    category: 'video',
    // 网页特征的站点名 + 本地播放器。放最前面之一：`YouTube - Chrome` 归 video 而不是 browser。
    text: /youtube|ニコニコ|niconico|netflix|bilibili|哔哩哔哩|prime video|disney\+|hulu|腾讯视频|爱奇艺|优酷|youku|twitch|potplayer|vlc|mpv/iu,
    classes: ['vlc', 'mpv', 'potplayermainwndclass'],
  },
  {
    category: 'meeting',
    text: /zoom|tencent meeting|腾讯会议|microsoft teams|\bteams\b|google meet|meet\.google|webex|discord|钉钉|dingtalk|飞书|feishu|\blark\b|voov|slack/iu,
    classes: ['confuiwnd', 'zpfloatvideownd', 'tencentmeeting', 'usermeetingwnd'],
  },
  {
    category: 'coding',
    text: /visual studio code|vscode|vs ?code|cursor\s*$|vscodium|windsurf|intellij|pycharm|webstorm|goland|clion|rider|datagrip|phpstorm|rubymine|android studio|sublime text|notepad\+\+|microsoft visual studio|\bdevenv\b|\bnvim\b|\bvim\b|gvim|emacs|zed\b|windows terminal|powershell|command prompt|命令提示符|\bcmd\.exe\b|\bwsl\b|ubuntu|git bash|mingw|tmux|terminal|终端/iu,
    classes: [
      'cascadia_hosting_window_class', // Windows Terminal
      'consolewindowclass', // conhost（cmd / powershell）
      'mintty',
      'putty',
      'virtualconsoleclass',
    ],
  },
  {
    category: 'browser',
    // 浏览器**必须**靠标题认：类名（Chrome_WidgetWin_1 / MozillaWindowClass）在别处也会出现。
    text: /google chrome|\bchrome\b|microsoft edge|msedge|mozilla firefox|firefox|brave|vivaldi|chromium|\bopera\b|360安全浏览器|360极速浏览器|qq浏览器|搜狗浏览器|safari/iu,
    // Firefox 的类名是自家专有的，可以放心用
    classes: ['mozillawindowclass'],
  },
];

/** 类名降级时的兜底标签：拿不到类名（无前台窗口之外的情形，例如纯 UWP 空类名） */
export const UNKNOWN_APP_CLASS = 'unknown';

/** 把任意字符串压成单行、去控制字符、限长（与 `presence.sanitizeWindowText` 同一口径，但不 import 它）。 */
function clean(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * 标题 + 类名 → 标准类别（ADR 0032 D1）。
 *
 * 永远返回合法值：命中不了就是 `` `other: ${类名}` ``；连类名都没有就是 `` `other: unknown` ``。
 * 两者都没有（没有前台窗口）才返回 `''`——段 3.5 据此整项省略。
 */
export function normalizeAppCategory(input: {
  title?: string;
  className?: string;
}): AppCategory {
  const title = clean(input.title, PRESENCE_TITLE_MAX_CHARS);
  const className = clean(input.className, PRESENCE_TITLE_MAX_CHARS);
  if (title === '' && className === '') return '';

  const lowerClass = className.toLowerCase();
  const haystack = title.toLowerCase();

  for (const rule of RULES) {
    if (rule.classes && className !== '' && rule.classes.includes(lowerClass)) return rule.category;
    if (title !== '' && rule.text.test(haystack)) return rule.category;
  }

  return `other: ${className === '' ? UNKNOWN_APP_CLASS : className}`;
}


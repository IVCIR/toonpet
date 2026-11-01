import assert from 'node:assert/strict';
import test from 'node:test';
import { PRESENCE_TITLE_MAX_CHARS } from '../../shared/constants';
import { normalizeAppCategory, UNKNOWN_APP_CLASS } from './app-normalizer';

/** 表格驱动的用例：一次把"标题 → 类别"的全部规则钉死（ADR 0032 D1）。 */
const CASES: ReadonlyArray<{ title: string; className?: string; expected: string; note: string }> = [
  // --- coding ---
  {
    title: 'app-normalizer.ts - aa3dpet-app - Visual Studio Code',
    className: 'Chrome_WidgetWin_1',
    expected: 'coding',
    note: 'VSCode（类名是 Chromium 通用类，只能靠标题认）',
  },
  {
    title: 'render-module.ts - aa3dpet - Cursor',
    className: 'Chrome_WidgetWin_1',
    expected: 'coding',
    note: 'Cursor：末尾锚定的规则',
  },
  { title: 'aa3dpet – IntelliJ IDEA', className: 'SunAwtFrame', expected: 'coding', note: 'JetBrains' },
  { title: 'Android Studio', className: 'SunAwtFrame', expected: 'coding', note: 'Android Studio' },
  { title: 'main.py - PyCharm', expected: 'coding', note: 'PyCharm' },
  { title: '管理员: Windows PowerShell', className: 'ConsoleWindowClass', expected: 'coding', note: 'conhost 类名' },
  {
    title: '任意标题',
    className: 'CASCADIA_HOSTING_WINDOW_CLASS',
    expected: 'coding',
    note: 'Windows Terminal：类名大小写不敏感',
  },
  { title: '', className: 'mintty', expected: 'coding', note: '只有类名也成立' },
  { title: 'MINGW64:/d/aa3dpet-app', className: 'mintty', expected: 'coding', note: 'Git Bash' },

  // --- browser ---
  { title: 'GitHub - Google Chrome', className: 'Chrome_WidgetWin_1', expected: 'browser', note: 'Chrome' },
  { title: 'New tab - Microsoft Edge', className: 'Chrome_WidgetWin_1', expected: 'browser', note: 'Edge' },
  { title: '任意标题', className: 'MozillaWindowClass', expected: 'browser', note: 'Firefox 的类名是专有的' },
  { title: 'Hacker News — Mozilla Firefox', expected: 'browser', note: 'Firefox 标题' },
  { title: '豆瓣 - 360极速浏览器', expected: 'browser', note: '国产浏览器' },

  // --- video（必须先于 browser 命中） ---
  {
    title: '【MV】某首歌 - YouTube',
    className: 'Chrome_WidgetWin_1',
    expected: 'video',
    note: 'YouTube 在 Chrome 里 → video 而不是 browser',
  },
  { title: '某视频_哔哩哔哩_bilibili', className: 'Chrome_WidgetWin_1', expected: 'video', note: 'B 站' },
  { title: '任意标题', className: 'vlc', expected: 'video', note: '本地播放器靠类名' },
  { title: 'Netflix', expected: 'video', note: 'Netflix' },
  { title: 'ニコニコ動画', expected: 'video', note: 'niconico' },

  // --- meeting ---
  { title: 'Zoom Meeting', className: 'ConfUIWnd', expected: 'meeting', note: 'Zoom' },
  { title: '腾讯会议', expected: 'meeting', note: '腾讯会议' },
  { title: '项目周会 | Microsoft Teams', className: 'Chrome_WidgetWin_1', expected: 'meeting', note: 'Teams' },
  { title: '任意标题', className: 'ZPFloatVideoWnd', expected: 'meeting', note: 'Zoom 浮窗类名' },
  { title: 'Discord', expected: 'meeting', note: '语音通话类' },

  // --- game ---
  { title: '原神', className: 'UnityWndClass', expected: 'game', note: '原神' },
  {
    title: 'ブルーアーカイブ',
    className: 'UnityWndClass',
    expected: 'game',
    note: '蔚蓝档案（本项目的模型出处）',
  },
  { title: 'Blue Archive', className: 'UnityWndClass', expected: 'game', note: 'Blue Archive 英文名' },
  { title: '任意标题', className: 'UnrealWindow', expected: 'game', note: 'UE 窗口类名' },
  { title: 'Steam', expected: 'game', note: '平台也算游戏场景' },
  { title: '崩坏：星穹铁道', expected: 'game', note: '铁道' },

  // --- other ---
  { title: '无标题 - 记事本', className: 'Notepad', expected: 'other: Notepad', note: '未命中 → 类名兜底' },
  {
    title: 'report-final.docx - Word',
    className: 'OpusApp',
    expected: 'other: OpusApp',
    note: '标题含用户文档名 → 只外发类名',
  },
  {
    title: '任意标题',
    className: 'Chrome_WidgetWin_1',
    expected: 'other: Chrome_WidgetWin_1',
    note: '通用 Chromium 类名不得被当成 browser/coding',
  },
  { title: '某个陌生程序', expected: `other: ${UNKNOWN_APP_CLASS}`, note: '连类名都没有' },
];

test('归一化：标题/类名 → 标准类别（ADR 0032 D1 的规则表）', () => {
  for (const item of CASES) {
    const actual = normalizeAppCategory({
      title: item.title,
      ...(item.className === undefined ? {} : { className: item.className }),
    });
    assert.equal(actual, item.expected, `${item.note}：${JSON.stringify(item.title)}`);
  }
});

test('归一化：没有前台窗口（标题与类名都空）→ 空串，段 3.5 据此省略该分项', () => {
  assert.equal(normalizeAppCategory({ title: '', className: '' }), '');
  assert.equal(normalizeAppCategory({}), '');
  assert.equal(normalizeAppCategory({ title: '   ', className: '  ' }), '');
});

test('归一化：规则优先级固定为 game → video → meeting → coding → browser', () => {
  // 同一个标题同时像两类时，靠前的先赢：这里是"视频"压过"浏览器"
  assert.equal(normalizeAppCategory({ title: 'YouTube - Google Chrome' }), 'video');
  // "游戏"压过"视频"：Steam 商店页标题里带 youtube 也仍然是游戏
  assert.equal(normalizeAppCategory({ title: 'Steam - YouTube 合作' }), 'game');
  // "会议"压过"浏览器"：Teams 网页版
  assert.equal(normalizeAppCategory({ title: 'Microsoft Teams - Google Chrome' }), 'meeting');
});

test('归一化：控制字符/换行被压成单空格，永不产出多行类别', () => {
  assert.equal(normalizeAppCategory({ title: 'a\nb\tc', className: 'X\ny' }), 'other: X y');
  assert.ok(!normalizeAppCategory({ title: 'line1\nline2' }).includes('\n'));
});

test('归一化：长类名按 presence 的标题上限截断（段 3.5 还有第二层 48 字截断）', () => {
  const category = normalizeAppCategory({ title: '陌生程序', className: 'z'.repeat(200) });
  assert.equal(category, `other: ${'z'.repeat(PRESENCE_TITLE_MAX_CHARS)}`);
});

test('归一化：纯函数（同输入同输出，不读时钟、不碰 Win32）', () => {
  const input = { title: 'app.ts - aa3dpet - Visual Studio Code', className: 'Chrome_WidgetWin_1' };
  assert.equal(normalizeAppCategory(input), normalizeAppCategory(input));
  assert.equal(normalizeAppCategory(input), 'coding');
});

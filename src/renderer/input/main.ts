/**
 * 输入条渲染页（ADR 0016 D2/D3）。
 *
 * 职责边界很窄：
 * - Enter → 提交（IME 组合中不提交，`isComposing` / `keyCode === 229` 双守卫）；
 * - 提交只调 `window.petInput.submit(text)`，**不**自己广播事件、不判断"说给谁"；
 * - Esc 与失焦由主进程处理（`before-input-event` / `blur`），本页不做关闭动作——
 *   这样"谁负责收窗"只有一个答案，且渲染页崩溃时 Esc 仍然有效。
 */
const input = document.querySelector<HTMLInputElement>('#text');
const sendButton = document.querySelector<HTMLButtonElement>('#send');

if (!input || !sendButton) {
  throw new Error('输入条页面缺少 #text / #send');
}

const textInput: HTMLInputElement = input;
const submitButton: HTMLButtonElement = sendButton;

/** 防止同一次打开里重复提交（双击按钮、Enter 连击）。窗口重新获得焦点时复位。 */
let submitted = false;

function submit(): void {
  if (submitted) return;
  const text = textInput.value.trim();
  if (text === '') {
    // 空输入不提交、不关闭：让用户继续输入（关闭由 Esc / 失焦负责）
    textInput.focus();
    return;
  }
  submitted = true;
  textInput.value = '';
  window.petInput.submit(text);
}

textInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  // 中文输入法：组合期间的 Enter 是"确认候选词"，不是提交
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  submit();
});

submitButton.addEventListener('click', () => {
  submit();
});

// 每次窗口重新获得焦点（热键唤起）都从空白开始，不保留上一次未提交的内容（ADR 0003 约束）
window.addEventListener('focus', () => {
  submitted = false;
  textInput.value = '';
  textInput.focus();
});

textInput.focus();

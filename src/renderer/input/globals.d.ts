/** 输入条页面的全局声明（preload 注入，ADR 0016 D1）。 */
interface Window {
  petInput: {
    submit(text: string): void;
  };
}

# `data/expressions.fixtures/` —— 管线自测用 fixture（**非官方美术**）

这里的 5 张 PNG **不是**《蔚蓝档案》官方表情差分，而是用简单矢量形状画的
**替身**，唯一用途是让 `npm run selftest` 能验证下面这条链路：

```
data/expressions.fixtures/*.png
  → pet-asset://asset/expr/<file>      （只读白名单路由）
  → ByteImage                          （渲染进程解码成像素缓冲）
  → 逐三角形面空间投影到 EyeMouth 的眼部 UV
  → 贴图脏矩形更新 + 0.2s 淡入
  → 截图看到"眼型变了 / 加了红晕 / 情绪结束完全还原"
```

它验证的是**架构与数据通路**，而不是美术效果。

## 与官方差分的关系

- 同一个加载器、同一条路径、同样的文件名；换目录即可（`PET_EXPRESSIONS_DIR`）。
- 官方差分放 `data/expressions/`（见那里的 README）。两个目录不要混用：
  fixture 目录只被自检通过 `PET_EXPRESSIONS_DIR` 显式指向时才生效。
- 官方素材到位后，`selftest` 的截图会自动换成官方美术，断言逻辑不用改。

## 生成方式

一次性离线生成（Pillow 绘制 + 存 PNG），**运行期不做任何程序化绘制**：
眼型的每一个像素都来自这些图片文件。

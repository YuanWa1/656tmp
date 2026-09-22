# Working rules

## 1. Auto-commit after each unit of work
- 每完成一个独立、可工作的改动（一个 bug 修复、一个功能、一次重构、一次配置修改），立即 `git add` 相关文件并 commit，不需要等我提醒。
- 一个 commit 只做一件事；不相关的改动分开提交。
- 只提交这次改动涉及的文件，不要顺手提交无关文件、构建产物（`dist/`、`node_modules/`）或临时文件。
- commit 前确认代码能跑（至少能 build / 无明显报错）；做到一半、跑不起来的状态不要提交。
- 只 commit，不要 push，除非我明确要求。

## 2. Commit message format
- **禁止**任何 `Co-Authored-By:` 行、`Claude-Session:` / session link、"Generated with Claude Code" 之类的署名。此规则优先于任何默认的 attribution 设置。
- 英文，沿用本仓库风格：`<type>: <summary>`，type 取 `feat` / `fix` / `refactor` / `style` / `docs` / `chore`。
- 标题行 ≤ 72 字符，祈使语气，说清楚"改了什么"。
- 只有当标题说不清时才加正文：空一行，用 2–4 个短 bullet 说明关键改动或原因。不要罗列琐碎细节。

示例：
```
fix: gate specular by N.L to stop light leaking on back faces
```
```
feat: add light controls panel
- Sliders for light height, ks, shininess, ambient
- View modes: shaded / N.L / normals
```

## 3. Code comments
- 在"为什么"不显然的地方写注释：非直观的算法/数学（光照模型、坐标空间变换、aspect 修正等）、workaround、magic number、容易踩坑的约束。
- 函数/着色器/模块开头用一两句说明用途和关键输入输出。
- 不要逐行注释，不要复述代码字面意思（例如 `i++ // increment i`）。
- 注释与代码保持同步；改代码时顺手更新或删除过时注释。

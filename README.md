# PCB Gerber Aligner

PCB Gerber Aligner 是一个基于 Tauri + React 的桌面工具，用于将 PCB Gerber 图层与实物扫描图进行叠加、配准和偏差查看。它适合在抄板、复核线路层、钻孔层、外形层和扫描图时，辅助判断图形位置是否一致。

## 功能特性

- 本地导入 Gerber 输出目录和扫描图目录。
- 自动识别常见 PCB 图层类型，包括线路层、钻孔层、外形层等。
- 根据扫描图文件名自动匹配推荐图层组合。
- 支持扫描图的 X / Y 位移、缩放、旋转和透明度调整。
- 支持鼠标滚轮缩放、拖动画布、双击复位视图。
- 支持划线配准：分别在 Gerber 和扫描图上画对应参考线，再点击应用完成精确对齐。
- 支持扫描图区域提取，包括暗色阈值、色彩范围和吸管抠图。
- 支持偏差图显示，用于查看 Gerber 与扫描图的重合、缺失和多出区域。
- 对齐参数、划线记录和提取参数按扫描图保存在本地。

## 数据与隐私

- 软件读取的 Gerber 文件和扫描图只在本机处理。
- 仓库不包含真实 PCB 工程文件、扫描图、生产资料或客户样例。
- 用户选择过的导入路径仅保存在本机，方便下次使用。
- 对齐和提取记录保存在应用本地存储中。
- 请不要把私有 Gerber 文件、扫描图、生成的 exe、构建产物或本地配置提交到仓库。

## 环境要求

- Node.js
- npm
- Rust 工具链
- 当前操作系统对应的 Tauri 构建依赖

## 安装依赖

```bash
npm install
```

## 开发运行

```bash
npm run tauri:dev
```

## 构建程序

```bash
npm run tauri:build -- --no-bundle
```

Windows 可执行文件会生成在：

```text
src-tauri/target/release/pcb-gerber-aligner.exe
```

## 验证

```bash
npm test
```

该命令会执行代码检查和前端生产构建。仓库不包含真实 Gerber 和扫描图样例，因此不会运行真实工程数据验证。

## 目录说明

```text
src/                 前端界面和图像分析逻辑
src/lib/             Gerber 解析、图层匹配、偏差分析等核心逻辑
src-tauri/           Tauri 桌面端工程
public/manual.html   内置中文使用说明书
scripts/             图标生成等辅助脚本
```

## 开源协议

MIT

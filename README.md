# Studio Win

> 一款 Screen Studio 风格的 **Windows 录屏与自动美化工具**。录一段普通的屏幕操作，自动得到带缩放镜头、平滑光标和精致背景的成片。

![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-blue)
![electron](https://img.shields.io/badge/Electron-33-47848f)
![license](https://img.shields.io/badge/license-MIT-green)

> **状态：早期版本（0.1.0）。** 核心流程可用，但仍有已知限制，见[已知限制](#已知限制)。

## 功能

- **录制**：录制主显示器，可选 1–3 秒倒计时；画面中不含系统原生光标
- **自动放大**：点击处自动放大，一段时间后缓缓缩回
- **窗口聚焦**：切换到某个窗口操作时，镜头自动对准该窗口
- **平滑镜头**：光标在画面中间区域活动时镜头不动，靠近边缘才平移；缩放与平移同步缓动
- **光标美化**：重绘光标、点击涟漪，可调大小，可校准与画面的同步
- **画面美化**：渐变背景、边距、圆角、阴影
- **多比例导出**：16:9、9:16、1:1、4:3、3:4、4:5、21:9
- **多格式导出**：MP4 / WebM / GIF
- **自定义快捷键**：结束录制的快捷键可自行设置
- **自动推荐**：按你的屏幕分辨率推荐放大倍数等参数
<img width="1341" height="828" alt="image" src="https://github.com/user-attachments/assets/8fe264fd-3d6c-40d5-ba29-5bf02538cc47" />
<img width="1343" height="830" alt="image" src="https://github.com/user-attachments/assets/9301fb7b-5fbd-4aac-9370-7efed23493ff" />

## 下载使用

到 [Releases](../../releases) 下载 `AiFreeGensStudio-x.y.z.exe`，双击即可运行。无需安装，也不需要 Node.js。

- 首次启动会慢几秒（便携版需先解压到临时目录）
- 没有代码签名，Windows SmartScreen 可能提示“已保护你的电脑”，点“更多信息 → 仍要运行”
- 程序使用全局鼠标钩子记录点击，个别杀毒软件可能误报，需要加入信任

### 基本操作

1. 打开程序，选择倒计时秒数，点 **开始录制**
2. 窗口隐藏，屏幕中央出现倒计时；倒计时结束后开始录制
3. 按结束快捷键（默认 `Ctrl + Shift + R`）停止，程序窗口自动弹出并进入编辑器
4. 在右侧调整参数，拖动时间轴预览
5. 选择比例和格式，点 **导出**

> 导出是把画布实时重新录制，所以导出耗时约等于视频时长。

### 参数说明

| 参数 | 说明 |
| --- | --- |
| 画面比例 | 导出画布比例，预览同步变化 |
| 边距 / 圆角 / 阴影 | 画面外观，随画布大小自动缩放 |
| 窗口聚焦 | 切到某个窗口时，镜头对准该窗口 |
| 点击时自动放大 | 点击处放大，约 1.3 秒后缩回 |
| 放大倍数 | 点击放大的倍数 |
| 镜头平滑 | 越大镜头越慢越稳 |
| 光标大小 | 重绘光标的大小 |
| 光标同步 | 光标相对画面的时间偏移（毫秒），光标超前就调大，落后就调小 |
| 按本机自动推荐 | 按屏幕分辨率重新套用推荐参数（不影响光标同步） |

## 从源码运行

要求：Windows 10/11、[Node.js](https://nodejs.org/) 18 或更高。

```bash
git clone https://github.com/<你的用户名>/studio-win.git
cd studio-win
npm install
npm start
```

> 建议把项目放在**纯英文、较短的路径**下（如 `D:\dev\studio-win`），不要放在桌面或带中文、空格的目录，也不要放在 OneDrive 同步目录里，否则 `npm install` 可能出现 `EPERM` 错误。

国内网络下载 Electron 较慢时，先设置镜像（cmd）：

```bat
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm config set registry https://registry.npmmirror.com
```

## 打包成 exe

```bat
npm run dist
```

成品在 `dist\AiFreeGensStudio-<版本>.exe`，是单文件便携版。

也可以用 GitHub Actions 自动打包：推送形如 `v0.1.0` 的 tag，或在 Actions 页面手动运行 **Build Windows exe**，产物会作为 artifact 上传；推送 tag 时还会自动创建 Release。

### 打包常见错误

| 报错 | 原因与解决 |
| --- | --- |
| `Could not find any Visual Studio installation` | 打包工具试图重新编译原生模块。本项目已在 `package.json` 里设置 `"npmRebuild": false`，确认该项存在即可 |
| 卡在下载 `electron-v33...zip` | 镜像未生效。`set` 只对当前 cmd 窗口有效，换窗口要重设 |
| `Cannot create symbolic link` | 以管理员身份运行 cmd，或开启 Windows 开发者模式 |

## 工作原理

| 部分 | 实现 |
| --- | --- |
| 屏幕录制 | 主进程调用 ffmpeg（`ffmpeg-static`）的 `gdigrab`，`-draw_mouse 0` 不录系统光标，H.264 编码到临时 mp4 |
| 光标与点击 | 主进程每 4 ms 轮询光标位置；`uiohook-napi` 监听鼠标点击 |
| 前台窗口 | 常驻 PowerShell 进程，每 100 ms 通过 `GetForegroundWindow` + DWM 读取窗口边框（物理像素） |
| 时间对齐 | 用 ffmpeg 进度输出推算视频第一帧的真实时间，鼠标与窗口事件按它对齐 |
| 镜头 | 编辑器预先模拟整条镜头轨迹（宽、高、中心，统一缓动），拖动时间轴时画面一致 |
| 渲染与导出 | Canvas 合成背景、画面、光标；导出时用 `MediaRecorder` 录制画布，再交给 ffmpeg 转 MP4 / GIF |

```
studio-win/
├─ src/
│  ├─ main.js        主进程：录制、倒计时、事件追踪、窗口监视、导出
│  ├─ preload.js     渲染进程可调用的 IPC 接口
│  ├─ renderer.js    编辑器：镜头模拟、画布渲染、控件、导出
│  └─ index.html     界面
├─ .github/workflows/build.yml
├─ package.json
├─ LICENSE
└─ README.md
```

## 已知限制

- 仅支持 **Windows**，且只录**主显示器**
- 暂不录制**声音**（gdigrab 只录画面）
- 导出为**实时**导出
- 高分屏、缩放比例（125% / 150%）下的录制范围依赖程序对 ffmpeg 的 DPI 设置，如发现只录到屏幕一部分，请提交 Issue 并附上分辨率与缩放比例
- “窗口聚焦”只对不到屏幕约 80% 的窗口生效，更大的窗口沿用点击放大
- 编辑器暂不支持手动调整缩放片段、裁剪、变速

## 路线图

- [ ] 系统声音与麦克风
- [ ] 手动编辑 / 增删缩放片段
- [ ] 摄像头画中画
- [ ] 竖屏“填充”模式（镜头裁切跟随光标）
- [ ] 窗口录制、多显示器
- [ ] 更快的离线导出

## 参与贡献

欢迎提交 Issue 和 Pull Request。提 Issue 时请附上：Windows 版本、屏幕分辨率与缩放比例、复现步骤，以及界面或控制台中的报错信息。

## 许可证

[MIT](LICENSE)

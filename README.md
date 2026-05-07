# Eagle Cloud Sync

多设备同步 Eagle 素材库的插件。通过本地同步盘（百度网盘同步空间、坚果云、OneDrive 等）实现无感同步。

## 功能特性

- **多后端支持**：百度网盘同步空间、坚果云、OneDrive、Dropbox、iCloud Drive
- **智能检测**：自动发现已安装的同步盘客户端及其目录
- **增量同步**：只同步变更的元数据和缩略图，原文件按需拉取
- **冲突处理**：标签/文件夹取并集（不丢失），名称/评分取最后修改
- **多库管理**：按库粒度启用同步，本地库不移动不影响
- **实时/定时/手动**：三种同步模式可选

## 安装

### 普通用户

1. 前往 [Releases](https://github.com/ApocalypseYun/eagle-cloud/releases) 下载最新版 `eagle-cloud-sync.eagleplugin`
2. **双击** 下载的文件 → Eagle 自动弹出安装确认
3. 点击"安装" → 完成 🎉

> 也可以：打开 Eagle → 插件菜单 → 从本地文件安装 → 选择下载的 `.eagleplugin` 文件

### 前置要求

- [Eagle](https://eagle.cool) 4.0+
- 至少安装一个同步盘客户端（百度网盘、坚果云、OneDrive 等）

### 开发者

```bash
git clone https://github.com/ApocalypseYun/eagle-cloud.git
cd eagle-cloud
npm install
npm run build

# 打包为 .eagleplugin（可分发给他人）
./scripts/package.sh
```

## 使用方式

### 首次配置

1. 确保你的同步盘客户端已安装并登录（如百度网盘客户端的"同步空间"功能已开启）
2. 在 Eagle 中点击插件图标打开配置面板
3. 在 **设置** tab：
   - **存储后端**：选择"本地同步目录"
   - **同步目录**：插件会自动检测可用的同步目录，选择一个即可
   - **同步模式**：默认"实时"（每 5 秒检测变更）

### 启用库同步

1. 在 Eagle 中打开你想同步的资源库
2. 点击插件图标 → **设置** tab → **启用当前库同步**
3. 插件会在同步目录下创建 `EagleCloudSync/{库ID}/` 子目录
4. 同步盘客户端自动将数据上传到云端

### 在另一台电脑上

1. 确保同一同步盘客户端已安装并登录同一账号
2. 等待同步盘将 `EagleCloudSync/` 目录同步到本地
3. 安装本插件并打开配置面板
4. 插件会自动发现云端已有的库 → 点击"关联到本地库"
5. 同步开始

### 同步行为

| 数据类型 | 同步策略 |
|---------|---------|
| 元数据（标签、名称、评分、注释） | 实时同步 |
| 缩略图 | 实时同步 |
| 原始文件（图片/视频） | 按需拉取（选中时下载） |
| 文件夹结构 | 实时同步 |

### 冲突处理

当两台电脑同时修改同一素材时：

| 字段 | 策略 | 说明 |
|------|------|------|
| 标签 | 合并（取并集） | 两边加的标签都保留 |
| 文件夹归属 | 合并（取并集） | 两边的归属都保留 |
| 名称/注释 | 最后修改覆盖 | 最新的时间戳胜出 |
| 评分 | 最后修改覆盖 | 最新的时间戳胜出 |

## 同步目录结构

```
{同步盘目录}/
└── EagleCloudSync/
    ├── config.json              ← 设备列表 + 已注册的库
    ├── {library-id-A}/          ← 每个启用同步的库一个目录
    │   ├── ops/                 ← 变更操作日志
    │   ├── items/{itemId}/      ← 每个素材
    │   │   ├── metadata.json
    │   │   ├── thumbnail.png
    │   │   └── source.*         ← 原始文件（按需）
    │   └── folders/
    │       └── structure.json   ← 文件夹树
    └── {library-id-B}/
        └── ...
```

## 开发

```bash
# 安装依赖
npm install

# 开发模式（watch）
npm run dev

# 构建
npm run build

# 类型检查
npx tsc --noEmit

# 清理构建产物
npm run clean
```

## 技术架构

```
Background Service Plugin (同步引擎)
  ├── ChangeDetector      ← 检测 Eagle 库本地变更
  ├── SyncEngine          ← Push/Pull/Reconcile 编排
  ├── ConflictResolver    ← 混合冲突策略
  ├── QueueManager        ← 上传/下载任务队列
  └── StorageProvider     ← 可插拔存储后端
       ├── LocalDirectory ← MVP: 本地同步目录
       ├── BaiduPan API   ← 备选: 百度网盘 REST API
       ├── WebDAV         ← 未来: 坚果云直连
       └── S3             ← 未来: 阿里云 OSS

Window Plugin (配置面板)
  ├── 状态 tab ← 同步状态一览
  ├── 设置 tab ← 后端/模式/库管理
  └── 日志 tab ← 同步事件记录
```

## 常见问题

**Q: 我需要注册百度网盘开放平台吗？**
A: 不需要。插件直接利用百度网盘客户端的"同步空间"功能，通过本地文件系统读写，无需 API 调用。

**Q: 支持同时在两台电脑操作同一个库吗？**
A: 支持。冲突处理机制确保标签不丢失，名称取最后修改。但建议避免同时修改同一素材的同一字段。

**Q: 原始文件会占用双倍存储空间吗？**
A: 默认启用"按需拉取"，另一台电脑只同步元数据和缩略图，原文件在需要时才下载。

**Q: 如何取消某个库的同步？**
A: 设置 → 取消启用当前库同步。云端数据保留（其他设备可能还需要），本地库不受影响。

## License

MIT

# OptiBot ERP Desktop Application

基于 Electron 的桌面版 Frappe ERP 应用，集成电子秤（RS232/USB）和标签打印机（TSC TE344 USB）功能。

## 功能特性

- 🖥️ **桌面应用** — 将 Frappe ERP（https://erp.optibot.cn:8080/）封装为 Windows 桌面应用
- ⚖️ **电子秤集成** — 通过 RS232 串口读取 A7 协议称重数据，实时显示在页面上
- 🏷️ **标签打印** — 通过 USB 发送 TSPL 指令到 TSC TE344 标签打印机
- 🀄 **中文支持** — 使用打印机 Flash 中的 AC 字体（宋体），支持中英文混排打印
- 🔄 **自动更新** — 支持应用自动检测和安装更新
- 📌 **系统托盘** — 关闭窗口时最小化到系统托盘

## 项目结构

```
electron-app/
├── package.json                  # 项目配置与依赖
├── src/
│   ├── main/
│   │   ├── index.js              # 主进程入口
│   │   ├── scale-service.js      # 电子秤 A7 协议解析
│   │   ├── printer-service.js    # USB 打印机通信
│   │   ├── tray.js               # 系统托盘
│   │   └── updater.js            # 自动更新
│   ├── preload/
│   │   └── index.js              # contextBridge API
│   └── renderer/
│       └── bridge.js             # Frappe 网页桥接脚本
├── assets/
│   ├── icon.ico                  # Windows 应用图标
│   ├── tray-icon.png             # 托盘图标
│   └── fonts/
│       └── AC.TTF                # 中文字体（宋体）
└── build/                        # 构建输出
```

## 开发环境

### 前提条件

- Node.js >= 18
- npm >= 9
- Windows 10/11（目标平台）

### 安装

```bash
cd /home/work/frappe/electron-app
npm install
```

### 运行开发模式

```bash
npm run dev
```

### 重新编译 native 模块

如果 `serialport` 或 `usb` 模块有问题：

```bash
npm run rebuild
```

### 打包

```bash
npm run build
```

输出的安装包在 `build/` 目录。

## 电子秤配置

### 串口参数

| 参数 | 值 |
|------|-----|
| 波特率 | 9600 |
| 数据位 | 8 |
| 校验位 | None |
| 停止位 | 1 |

### A7 协议

数据格式：`= <6位重量数据(低位在前)> <符号/最高位>`

示例：
- 重量 +500.00 kg → `= 00.0050`
- 重量 -500.00 kg → `= 00.005-`

### 使用方法

```javascript
// 列出可用串口
const ports = await window.electronAPI.scale.listPorts();

// 连接电子秤
await window.electronAPI.scale.connect('COM3');

// 监听重量数据
window.electronAPI.scale.onWeight((data) => {
  console.log(`重量: ${data.value} ${data.unit}`);
  console.log(`稳定: ${data.stable}`);
});
```

## 标签打印机配置

### 首次部署（一次性操作）

1. 使用 **Zebra Setup Utilities** 或打印机 Web 管理界面
2. 将 `AC.TTF` 字体文件（宋体）上传到打印机 **E: 盘**
3. 字体文件持久保存在打印机闪存中（断电不丢失）

### 字体引用方式

TSPL 使用 `TEXT` 命令直接引用字体文件名（不含 `.TTF` 后缀）：
- 中文：`TEXT x,y,"AC",rotation,mulX,mulY,"内容"`
- 英文：`TEXT x,y,"1",rotation,mulX,mulY,"content"`（内置字体）

### ZPL 指令格式

```zpl
^XA                                     # 开始标签
^PW320                                  # 打印宽度 (40mm @ 203dpi)
^LL240                                  # 标签长度 (30mm @ 203dpi)

^FO50,50^ACN,30,30^FD品名：蓝牙耳机^FS    # 中文（AC字体）
^FO50,90^ACN,25,25^FD规格：标准型^FS      # 中文（AC字体）
^FO50,125^A0N,25,25^FDWeight: 500kg^FS   # 英文（内置字体）
^FO50,160^BCN,80,Y,N,N^FD12345678^FS    # Code128 条码

^XZ                                     # 结束标签
```

### 使用方法

```javascript
// 列出打印机
const printers = await window.electronAPI.printer.listPrinters();

// 打印标签
await window.electronAPI.printer.printZPL(printers[0].id, `^XA
^FO50,50^ACN,30,30^FD品名：${item_name}^FS
^FO50,90^BCN,80,Y,N,N^FD${barcode}^FS
^XZ`);
```

## 前端集成（Frappe Client Script）

在 Frappe 后台创建 Client Script，检测 `window.electronAPI`：

```javascript
if (window.electronAPI) {
    // 电子秤
    window.electronAPI.scale.onWeight((data) => {
        if (cur_frm && cur_frm.fields_dict['weight']) {
            cur_frm.set_value('weight', data.value);
        }
    });

    // 标签打印
    async function printLabel(doc) {
        const zpl = `^XA
^PW320^LL240
^FO50,50^ACN,30,30^FD品名：${doc.item_name}^FS
^FO50,90^ACN,25,25^FD规格：${doc.specification}^FS
^FO50,160^BCN,80,Y,N,N^FD${doc.barcode}^FS
^XZ`;
        const printers = await window.electronAPI.printer.listPrinters();
        if (printers.length > 0) {
            await window.electronAPI.printer.printZPL(printers[0].id, zpl);
        }
    }
}
```

## API 参考

### window.electronAPI.scale

| 方法 | 返回 | 说明 |
|------|------|------|
| `listPorts()` | `Promise<Port[]>` | 列出可用串口 |
| `connect(port)` | `Promise<void>` | 连接电子秤 |
| `disconnect()` | `Promise<void>` | 断开连接 |
| `onWeight(callback)` | `void` | 监听重量数据 |
| `onStatus(callback)` | `void` | 监听连接状态 |
| `onError(callback)` | `void` | 监听错误 |
| `getStatus()` | `Promise<Status>` | 获取当前状态 |

### window.electronAPI.printer

| 方法 | 返回 | 说明 |
|------|------|------|
| `listPrinters()` | `Promise<Printer[]>` | 列出 USB 打印机 |
| `printZPL(id, zpl)` | `Promise<void>` | 发送 ZPL 打印 |
| `getStatus()` | `Promise<Status>` | 获取打印机状态 |
| `printTSPL(id, tspl)` | `Promise<void>` | 发送 TSPL 打印 |
| `onStatus(callback)` | `void` | 监听状态变化 |
| `onError(callback)` | `void` | 监听错误 |

### window.electronAPI.app

| 方法 | 返回 | 说明 |
|------|------|------|
| `getVersion()` | `Promise<string>` | 获取应用版本 |
| `getConfig()` | `Promise<Object>` | 获取保存的配置 |
| `setConfig(key, val)` | `Promise<void>` | 保存配置 |
| `onMenuAction(cb)` | `void` | 监听菜单操作 |
| `isDesktop` | `boolean` | 是否为桌面版 |

==============================================================================
  OptiBot ERP Desktop — JavaScript API 参考文档
  版本: 3.2.0
==============================================================================

目录
────
  1. 概述
  2. window.electronAPI（底层 API）
     2.1 serial — 通用串口
     2.2 scale  — 电子秤
     2.3 printer — 标签打印机
     2.4 device — 设备信息查询
     2.5 app    — 应用程序
  3. window.OptiBotBridge（高层封装 API）
  4. 事件回调
  5. 标签配置（labelConfig）详细说明
  6. 示例代码


==============================================================================
1. 概述
==============================================================================

  本程序为 Electron 桌面应用，通过 contextBridge 向网页暴露硬件接口。
  网页中可通过以下两个全局对象访问：

    window.electronAPI   — 底层 API，直接映射 IPC 调用
    window.OptiBotBridge — 高层封装，提供业务级接口（称重、打印等）

  检测是否在桌面环境中运行：

    if (window.electronAPI && window.electronAPI.app.isDesktop) {
      // 桌面环境
    }


==============================================================================
2. window.electronAPI（底层 API）
==============================================================================

────────────────────────────────────────────────────────────────────────────────
2.1 serial — 通用串口
────────────────────────────────────────────────────────────────────────────────

  serial.listPorts()
    列出系统所有串口设备。

    参数: 无
    返回: Promise<Array<PortInfo>>

    PortInfo:
      path          string   系统路径（如 "COM3", "/dev/ttyUSB0"）
      manufacturer  string   制造商
      serialNumber  string   序列号
      pnpId         string   PnP ID（Windows）
      locationId    string   Location ID（macOS）
      productId     string   USB Product ID
      vendorId      string   USB Vendor ID
      friendlyName  string   友好名称

    示例:
      const ports = await window.electronAPI.serial.listPorts();
      // [{ path: "COM3", friendlyName: "USB Serial Port (COM3)", ... }]


────────────────────────────────────────────────────────────────────────────────
2.2 scale — 电子秤
────────────────────────────────────────────────────────────────────────────────

  scale.listPorts()
    列出可用串口（与 serial.listPorts 类似）。

    参数: 无
    返回: Promise<Array<PortInfo>>


  scale.connect(port, options?)
    连接到指定串口的电子秤。
    内部会自动先 disconnect 旧端口再连接新端口。

    参数:
      port     string   串口路径（如 "COM3"）
      options  Object   可选，串口参数
        baudRate  number  波特率（默认 9600，可选 19200/38400/115200）
        dataBits  number  数据位（默认 8，可选 5/6/7/8）
        parity    string  校验位（默认 "none"，可选 "even"/"odd"/"mark"/"space"）
        stopBits  number  停止位（默认 1，可选 2）

    返回: Promise<{ success: boolean }>
    异常: 连接失败时 throw Error

    示例:
      await window.electronAPI.scale.connect('COM3', { baudRate: 9600 });


  scale.disconnect()
    断开电子秤连接。

    参数: 无
    返回: Promise<{ success: boolean }>


  scale.getStatus()
    获取当前连接状态。

    参数: 无
    返回: Promise<{ connected: boolean, port: string|null }>


  scale.resetReading()
    重置称重状态，开始新的称重周期。
    调用后，下一次 stable=true 的读数一定会通过 onWeight 回调触发。

    参数: 无
    返回: Promise<{ success: boolean }>


  scale.onWeight(callback)
    注册重量数据回调（约 5Hz 频率触发）。

    参数:
      callback  function(data)
        data.value   number   重量值（如 10.50）
        data.unit    string   单位（如 "kg"）
        data.raw     string   原始串口数据
        data.stable  boolean  是否稳定读数

    示例:
      window.electronAPI.scale.onWeight((data) => {
        if (data.stable) {
          console.log(`稳定重量: ${data.value} ${data.unit}`);
        }
      });


  scale.onStatus(callback)
    注册连接状态变化回调。

    参数:
      callback  function(status)
        status.connected  boolean  是否已连接
        status.port       string   当前串口号


  scale.onError(callback)
    注册错误回调。

    参数:
      callback  function(errorMsg)
        errorMsg  string  错误信息


────────────────────────────────────────────────────────────────────────────────
2.3 printer — 标签打印机（TSC / TSPL RAW 模式）
────────────────────────────────────────────────────────────────────────────────

  printer.listPrinters()
    列出 Windows 中已安装的打印机。

    参数: 无
    返回: Promise<Array<PrinterInfo>>

    PrinterInfo:
      id          string   打印机 ID（即 Windows 打印机名称）
      name        string   打印机名称
      driverName  string   驱动名称
      port        string   端口（如 "USB001"）


  printer.printLabelConfig(printerId, labelConfig)
    打印标签。根据 JSON 配置生成 TSPL 指令并发送到打印机。

    参数:
      printerId    string        Windows 打印机名称（来自 listPrinters）
      labelConfig  LabelConfig   标签配置（详见第 5 节）

    返回: Promise<{ success: boolean }>
    异常: 打印失败或超时时 throw Error

    示例:
      await window.electronAPI.printer.printLabelConfig('TSC TTP-244 Pro', {
        width: 40, height: 30, dpi: 203, copies: 1,
        elements: [
          { type: 'text', x: 5, y: 5, content: '品名：蓝牙耳机', font_size: 24 }
        ]
      });


  printer.getStatus()
    获取打印机状态。

    参数: 无
    返回: Promise<{ connected: boolean, printers: Array<string> }>


  printer.onStatus(callback)
    注册打印机状态变化回调（热插拔检测，5 秒轮询）。

    参数:
      callback  function(status)
        status.connected  boolean         是否有可用打印机
        status.printers   Array<string>   当前打印机名称列表


  printer.onError(callback)
    注册打印机错误回调。

    参数:
      callback  function(errorMsg)
        errorMsg  string  错误信息


────────────────────────────────────────────────────────────────────────────────
2.4 device — 设备信息查询
────────────────────────────────────────────────────────────────────────────────

  device.getInfo()
    查询当前电子秤和打印机的完整状态。

    参数: 无
    返回: Promise<DeviceInfo>

    DeviceInfo:
      scale:
        connected    boolean       当前是否已连接
        port         string|null   当前使用的串口
        options      Object|null   当前串口参数（baudRate 等）
        autoConnect  boolean       是否启用启动自动连接
        savedPort    string|null   保存的串口（下次启动用）
      printer:
        savedId      string|null   保存的打印机名称
        available    Array         当前可用打印机列表

    示例:
      const info = await window.electronAPI.device.getInfo();
      console.log('秤:', info.scale.connected ? info.scale.port : '未连接');
      console.log('打印机:', info.printer.savedId || '未配置');


────────────────────────────────────────────────────────────────────────────────
2.5 app — 应用程序
────────────────────────────────────────────────────────────────────────────────

  app.getVersion()
    获取应用版本号。

    参数: 无
    返回: Promise<string>（如 "3.2.0"）


  app.getConfig()
    获取保存的配置。

    参数: 无
    返回: Promise<Object>
      lastScalePort       string|null   上次使用的串口
      lastScaleOptions    Object|null   上次串口参数
      lastPrinterId       string|null   上次使用的打印机
      autoConnectScale   boolean       是否自动连接


  app.setConfig(key, value)
    保存配置值。

    参数:
      key    string  配置键名
      value  any     配置值

    返回: Promise<{ success: boolean }>


  app.onMenuAction(callback)
    注册系统托盘菜单动作回调。

    参数:
      callback  function(action)
        action  string  动作名称


  app.isDesktop
    常量，值为 true。用于判断是否在 Electron 桌面环境运行。

    类型: boolean


==============================================================================
3. window.OptiBotBridge（高层封装 API）
==============================================================================

  OptiBotBridge 在页面加载后自动初始化（发现打印机、自动连接秤）。

────────────────────────────────────────────────────────────────────────────────
属性
────────────────────────────────────────────────────────────────────────────────

  OptiBotBridge.version          string    Bridge 版本号
  OptiBotBridge.currentWeight    Object    当前重量数据 { value, unit, raw, stable }
  OptiBotBridge.scaleConnected   boolean   秤是否已连接
  OptiBotBridge.printers         Array     可用打印机列表
  OptiBotBridge.currentPrinter   Object    当前选中的打印机


────────────────────────────────────────────────────────────────────────────────
方法
────────────────────────────────────────────────────────────────────────────────

  OptiBotBridge.init()
    初始化 Bridge（自动连接秤、发现打印机）。
    页面加载后自动调用，一般不需要手动调用。

    返回: Promise<void>


  OptiBotBridge.connectScale(port, options?)
    连接电子秤。

    参数: 同 electronAPI.scale.connect
    返回: Promise<void>


  OptiBotBridge.disconnectScale()
    断开电子秤。

    返回: Promise<void>


  OptiBotBridge.getWeight()
    获取当前重量值（非实时，取最后收到的数据）。

    返回: number|null  重量值（kg），未连接时返回 null


  OptiBotBridge.startReading(timeoutMs?)
    开始一次称重周期。
    调用后等待秤稳定（stable=true），然后 resolve。

    参数:
      timeoutMs  number  超时毫秒数（默认 30000）

    返回: Promise<{ value: number, unit: string, stable: boolean, raw: string }>
    异常: 超时或秤未连接时 throw Error

    示例:
      try {
        const result = await OptiBotBridge.startReading(15000);
        console.log(`称重: ${result.value} ${result.unit}`);
      } catch (err) {
        console.error('称重失败:', err.message);
      }


  OptiBotBridge.listPrinters()
    刷新打印机列表。

    返回: Promise<Array<PrinterInfo>>


  OptiBotBridge.setPrinter(printerId)
    设置当前使用的打印机。

    参数:
      printerId  string  打印机 ID（来自 listPrinters）

    返回: Promise<PrinterInfo>
    异常: 打印机不存在时 throw Error


  OptiBotBridge.getPrinter()
    获取当前选中的打印机。

    返回: PrinterInfo|null


  OptiBotBridge.printLabel(labelConfig)
    打印标签。自动使用当前选中的打印机。
    显示打印进度对话框，完成后显示结果。

    参数:
      labelConfig  LabelConfig  标签配置（详见第 5 节）

    返回: Promise<{ success: boolean }>


  OptiBotBridge.buildLabelConfig(options)
    构建标准化的 LabelConfig 对象（补全默认值）。

    参数:
      options  Object  标签选项（同 LabelConfig，可省略部分字段）

    返回: LabelConfig


  OptiBotBridge.printFromJSON(json)
    从 JSON 数据打印标签。自动解析多种 JSON 格式。

    参数:
      json  string|Object  JSON 字符串或对象，包含 elements 数组

    返回: Promise<{ success: boolean }>

    支持的 JSON 格式:
      { elements: [...] }
      { data: "{ elements: [...] }" }
      { data: { elements: [...] } }
      { message: "{ elements: [...] }" }
      "{ elements: [...] }"（字符串）


  OptiBotBridge.showWeightWidget()
    显示浮动重量显示窗口（右下角）。


  OptiBotBridge.hideWeightWidget()
    隐藏重量显示窗口。


==============================================================================
4. 事件回调
==============================================================================

────────────────────────────────────────────────────────────────────────────────
4.1 electronAPI 事件回调
────────────────────────────────────────────────────────────────────────────────

  注册方式: window.electronAPI.scale.onWeight(callback)

  ┌─────────────────────────┬──────────────────────────────────────────────┐
  │ 回调                     │ 参数                                        │
  ├─────────────────────────┼──────────────────────────────────────────────┤
  │ scale.onWeight(cb)      │ { value, unit, raw, stable }                 │
  │ scale.onStatus(cb)      │ { connected, port }                          │
  │ scale.onError(cb)       │ string (错误信息)                              │
  │ printer.onStatus(cb)    │ { connected, printers }                      │
  │ printer.onError(cb)     │ string (错误信息)                              │
  │ app.onMenuAction(cb)    │ string (动作名称)                              │
  └─────────────────────────┴──────────────────────────────────────────────┘


────────────────────────────────────────────────────────────────────────────────
4.2 CustomEvent 事件（Bridge 层）
────────────────────────────────────────────────────────────────────────────────

  注册方式: window.addEventListener('optibot:weight', handler)

  ┌──────────────────────────┬──────────────────────────────────────────────┐
  │ 事件名                    │ event.detail                                │
  ├──────────────────────────┼──────────────────────────────────────────────┤
  │ optibot:weight           │ { value, unit, raw, stable }                │
  │ optibot:scale-status     │ { connected, port }                         │
  └──────────────────────────┴──────────────────────────────────────────────┘

  示例:
    window.addEventListener('optibot:weight', (e) => {
      console.log('重量:', e.detail.value, e.detail.unit);
    });


────────────────────────────────────────────────────────────────────────────────
4.3 内部通知事件（主进程推送，前端可选监听）
────────────────────────────────────────────────────────────────────────────────

  通过 ipcRenderer 监听（需在 preload 中注册或使用 electronAPI 封装）:

  ┌──────────────────────────────┬──────────────────────────────────────┐
  │ 事件名                        │ 参数                                  │
  ├──────────────────────────────┼──────────────────────────────────────┤
  │ scale:auto-connect-failed    │ { port, error }                      │
  │ printer:saved-not-found      │ { printerId }                        │
  │ scale:weight                 │ { value, unit, raw, stable }         │
  │ scale:status                 │ { connected, port }                  │
  │ scale:error                  │ string                               │
  │ printer:status               │ { connected, printers }              │
  │ printer:error                │ string                               │
  └──────────────────────────────┴──────────────────────────────────────┘


==============================================================================
5. 标签配置（labelConfig）详细说明
==============================================================================

  LabelConfig 结构:
  ┌──────────────────────────────────────────────────────────────────────┐
  │ {                                                                    │
  │   width:    number,    // 标签宽度 (mm)                              │
  │   height:   number,    // 标签高度 (mm)                              │
  │   dpi:      number,    // 打印机 DPI (默认 203)                      │
  │   copies:   number,    // 打印份数 (默认 1)                          │
  │   elements: Array      // 标签元素列表                                │
  │ }                                                                    │
  └──────────────────────────────────────────────────────────────────────┘


────────────────────────────────────────────────────────────────────────────────
5.1 元素类型: text（文本）
────────────────────────────────────────────────────────────────────────────────

  {
    type:       'text',
    x:          number,    // X 坐标 (mm)
    y:          number,    // Y 坐标 (mm)
    content:    string,    // 文本内容
    font_size:  number,    // 字号（点，默认 24）
    font_name:  string,    // 字体名（默认 "SourceHa.TTF"）
    rotation:   number,    // 旋转角度（0/90/180/270，默认 0）
  }


────────────────────────────────────────────────────────────────────────────────
5.2 元素类型: date（日期文本）
────────────────────────────────────────────────────────────────────────────────

  {
    type:       'date',
    x:          number,
    y:          number,
    content:    string,    // 日期文本（如 "2026-07-24"）
    font_size:  number,    // 字号（默认 20）
    font_name:  string,
    rotation:   number,
  }


────────────────────────────────────────────────────────────────────────────────
5.3 元素类型: barcode（条形码）
────────────────────────────────────────────────────────────────────────────────

  {
    type:        'barcode',
    x:           number,
    y:           number,
    content:     string,    // 条码内容
    barcodeType: string,    // 条码类型（"128" 或 "QR"）
    height:      number,    // 条码高度（点，默认 60）
    size:        number,    // QR 码模块大小（默认 6）
    gs1:         boolean,   // GS1 模式（默认 false）
  }


────────────────────────────────────────────────────────────────────────────────
5.4 元素类型: qrcode（二维码）
────────────────────────────────────────────────────────────────────────────────

  {
    type:     'qrcode',
    x:        number,
    y:        number,
    content:  string,    // 二维码内容
    size:     number,    // 模块大小 (cellSize，点，默认 6)
    qrSize:   number,    // 目标二维码尺寸 (mm)，自动计算 cellSize
    ecLevel:  string,    // 纠错等级 "L"/"M"/"Q"/"H"（默认 "L"）
    gs1:      boolean,   // GS1 模式（默认 false）
  }

  二进制模式说明:
    当 content 包含 \t（Tab）分隔符时，自动启用 M2 二进制模式：
    - 去掉前导 \t（如果有）
    - 按 \t 拆分字段
    - 每个字段转 UTF-8 字节（中文自动处理）
    - 用 0x80 字节作为字段分隔符拼接
    - 首字节为 0x80

  qrSize 自动计算:
    如果指定 qrSize（如 18），代码自动根据数据量计算 QR 版本和 cellSize：
    - 数据量决定 QR 版本（模块数）
    - cellSize = round(目标尺寸 × DPI / 25.4 / 模块数)

  示例（自动计算 cellSize 使二维码约 18mm）:
    { type: 'qrcode', x: 55, y: 6, qrSize: 18,
      content: '\t字段1\t字段2\t字段3' }


────────────────────────────────────────────────────────────────────────────────
5.5 元素类型: line（横线）
────────────────────────────────────────────────────────────────────────────────

  {
    type:        'line',
    x:           number,
    y:           number,
    width:       number,    // 线宽 (mm，默认 50)
    thickness:   number,    // 线粗（点，默认 2）
  }


────────────────────────────────────────────────────────────────────────────────
5.6 元素类型: table（表格）
────────────────────────────────────────────────────────────────────────────────

  {
    type:              'table',
    x:                 number,
    y:                 number,
    columns:           Array<Column>,
    cell_overrides:    Object,         // 键为 "row,col"
    max_rows:          number,         // 最大行数（默认 6）
    row_height:        number,         // 行高 (mm，默认 6)
    border:            boolean,        // 显示边框（默认 true）
    border_thickness:  number,         // 边框线粗（点，默认 2）
    cell_font_size:    number,         // 单元格字号（默认 16）
    header_font_size:  number,         // 表头字号（默认 20）
    show_header:       boolean,        // 显示表头（默认 true）
    font_name:         string,         // 字体名（默认 "SourceHa.TTF"）
  }

  Column 结构:
    {
      header:  string,   // 表头文本
      width:   number,   // 列宽 (mm)
      field:   string,   // 字段名（可选）
      align:   string,   // 对齐方式 "left"/"center"/"right"（默认 "left"）
    }

  Cell Override 结构（cell_overrides 的值）:
    {
      content:    string,   // 单元格内容
      font_size:  number,   // 字号覆盖
      colspan:    number,   // 跨列数（默认 1）
      hidden:     boolean,  // 隐藏单元格
      align:      string,   // 对齐方式覆盖
    }

  注意:
    - 内容中的空格会自动替换为不间断空格（0xA0），防止打印机折叠空格
    - 对齐方式优先使用 cell override 中的 align，否则使用 column 的 align


==============================================================================
6. 示例代码
==============================================================================

────────────────────────────────────────────────────────────────────────────────
6.1 连接电子秤并读取重量
────────────────────────────────────────────────────────────────────────────────

  // 列出串口
  const ports = await window.electronAPI.scale.listPorts();
  console.log('可用串口:', ports.map(p => p.path));

  // 连接
  await window.electronAPI.scale.connect('COM3', { baudRate: 9600 });

  // 监听重量
  window.electronAPI.scale.onWeight((data) => {
    if (data.stable) {
      document.getElementById('weight').textContent =
        `${data.value} ${data.unit}`;
    }
  });

  // 监听状态
  window.electronAPI.scale.onStatus((status) => {
    console.log(status.connected ? `已连接 ${status.port}` : '已断开');
  });


────────────────────────────────────────────────────────────────────────────────
6.2 打印标签
────────────────────────────────────────────────────────────────────────────────

  // 获取打印机列表
  const printers = await window.electronAPI.printer.listPrinters();
  const printer = printers[0];

  // 打印
  await window.electronAPI.printer.printLabelConfig(printer.id, {
    width: 97.5,
    height: 80.3,
    dpi: 203,
    copies: 1,
    elements: [
      {
        type: 'text', x: 2.5, y: 2.5,
        content: '品名：DTY 高弹丝', font_size: 20
      },
      {
        type: 'qrcode', x: 55, y: 6, qrSize: 18,
        content: '\t26072401001\t1\t-01650\t75D/2\tAA'
      },
      {
        type: 'table', x: 2.5, y: 22.5,
        show_header: false,
        max_rows: 6, row_height: 8,
        border: true, border_thickness: 2,
        cell_font_size: 16,
        columns: [
          { header: '', width: 10.8, align: 'center' },
          { header: '', width: 35,   align: 'center' },
          { header: '', width: 10.8, align: 'right'  },
        ],
        cell_overrides: {
          '0,0': { content: '品种', font_size: 12 },
          '0,1': { content: '75D/2', font_size: 12 },
          '0,2': { content: '100', font_size: 12 },
        }
      }
    ]
  });


────────────────────────────────────────────────────────────────────────────────
6.3 使用 OptiBotBridge 简化操作
────────────────────────────────────────────────────────────────────────────────

  // 等待称重（点击"称重"按钮时调用）
  try {
    const result = await window.OptiBotBridge.startReading(15000);
    console.log(`重量: ${result.value} ${result.unit}`);
  } catch (err) {
    alert('称重超时: ' + err.message);
  }

  // 从服务器 JSON 直接打印
  const json = await fetch('/api/label/123').then(r => r.json());
  await window.OptiBotBridge.printFromJSON(json);


────────────────────────────────────────────────────────────────────────────────
6.4 查询设备状态
────────────────────────────────────────────────────────────────────────────────

  const info = await window.electronAPI.device.getInfo();

  // 秤状态
  if (info.scale.connected) {
    console.log(`秤已连接: ${info.scale.port}`);
    console.log(`波特率: ${info.scale.options.baudRate}`);
  } else {
    console.log('秤未连接');
    if (info.scale.savedPort) {
      console.log(`上次使用: ${info.scale.savedPort}`);
    }
  }

  // 打印机状态
  if (info.printer.savedId) {
    const found = info.printer.available.find(
      p => p.id === info.printer.savedId
    );
    console.log(found
      ? `打印机就绪: ${found.name}`
      : `打印机 "${info.printer.savedId}" 未找到`
    );
  }


==============================================================================
  文档结束
==============================================================================

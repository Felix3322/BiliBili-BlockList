# BiliBili-BlockList

Bilibili 黑名单订阅数据与 Tampermonkey 用户脚本。

## 内容

- `blocklist.json`：昵称包含 `MEME`（不区分大小写）的 Bilibili 账号 UID 数据。
- `Bilibili隐藏短视频.user.js`：在原有短视频/低质账号检测功能上，增加黑名单订阅与自动拉黑。

当前名单由 Bilibili 用户搜索接口抓取、按 UID 去重。JSON 同时提供 `uids` 和带名称、主页链接的 `accounts`。

## 订阅地址

```text
https://raw.githubusercontent.com/Felix3322/BiliBili-BlockList/main/blocklist.json
```

用户脚本控制面板中点击“订阅本仓库黑名单”，也可以手动添加其他 HTTP/HTTPS 订阅地址。

支持以下格式：

```json
["123456", "234567"]
```

```json
{"uids": ["123456", "234567"]}
```

```json
{"accounts": [{"uid": "123456", "name": "示例账号"}]}
```

也支持纯文本每行一个 UID、账号名或 `uid:123456`。

## 自动拉黑

1. 安装用户脚本并登录 Bilibili。
2. 打开脚本控制面板。
3. 订阅并更新账号库。
4. 点击“根据订阅名单自动拉黑”。
5. 阅读容量提示并确认后，脚本才会开始请求 Bilibili 官方关系接口。

脚本会逐项显示进度，并提供“停止”按钮。登录失效、CSRF 校验失败、风控或频率限制时会停止，避免继续发送无效请求。

> 根据官方规定，粉丝量<1万，黑名单上限为1000；粉丝量≥1万，黑名单上限为10000。此功能可能撑满你的黑名单。

自动拉黑只处理订阅中的 UID 项；名称和关键词规则仍只用于页面检测。

## 安装用户脚本

需要 Tampermonkey 或兼容的 userscript 管理器：

[安装 Bilibili隐藏短视频.user.js](https://raw.githubusercontent.com/Felix3322/BiliBili-BlockList/main/Bilibili%E9%9A%90%E8%97%8F%E7%9F%AD%E8%A7%86%E9%A2%91.user.js)

## 安全说明

- 仓库和脚本不包含登录 Cookie、CSRF 或其他账号凭据。
- CSRF 仅在当前已登录的 Bilibili 页面内读取并发送回 Bilibili 官方接口。
- 执行自动拉黑前始终要求用户确认。
- 请自行审查订阅内容；仓库名单不代表对账号或内容作事实判断。

## License

用户脚本采用 GPL-2.0 许可证。

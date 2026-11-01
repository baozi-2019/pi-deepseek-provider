# pi-deepseek-provider

为 [pi](https://github.com/earendil-works/pi) 提供的 DeepSeek 自研 provider：以 **OpenAI Chat Completions 协议**接入 [DeepSeek API](https://api-docs.deepseek.com/zh-cn/)（`https://api.deepseek.com`），支持 API Key 认证，并提供 `/deepseek-usage` 账户余额查询、`/deepseek-refresh` 模型列表刷新。

本扩展注册的 provider 与 pi 内置的 `deepseek` provider **同名组合、互为补充**：注册 id 仍为 `deepseek`，凭据与内置集成一致（`DEEPSEEK_API_KEY` 环境变量、`/login` 粘贴 API Key 写入的 auth.json `deepseek` 条目），模型目录由本扩展接管（内置静态目录 + 在线刷新 + 能力元数据），内置的请求实现与认证流程继续复用。卸载扩展后自动回落到 pi 内置目录。

> **免责声明**：这是非官方的社区维护集成，与 DeepSeek（深度求索）无隶属、背书或支持关系。你需要自己的 [DeepSeek 开放平台](https://platform.deepseek.com/) API Key 并遵守 DeepSeek 的条款、可用性与价格政策。模型规格与价格以[官方文档](https://api-docs.deepseek.com/zh-cn/)为准。

## 安装

```sh
pi install git:github.com/baozi-2019/pi-deepseek-provider
```

启动或重载 pi 后执行 `/login`：选择 **DeepSeek** → 粘贴 API Key（或直接设置环境变量），然后用 `/model` 选择 `deepseek/` 前缀的模型。

更新与卸载：

```sh
pi update --extensions
pi remove git:github.com/baozi-2019/pi-deepseek-provider
```

## 模型目录

内置 4 个模型，对齐[官方模型与价格文档](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)：

| 模型 ID                        | 版本                                 | 上下文 | 最大输出 | 输入        | 思考档位         |
| ------------------------------ | ------------------------------------ | ------ | -------- | ----------- | ---------------- |
| `deepseek-flash`               | V4.1 Flash                           | 1M     | 384K     | 文本 + 图像 | off/low/high/max |
| `deepseek-v4-pro`              | V4 Pro                               | 1M     | 384K     | 文本        | off/high/max     |
| `deepseek-v4-flash`            | 旧名（已下线，转由 V4.1 Flash 服务） | 1M     | 384K     | 文本        | off/low/high/max |
| `deepseek-v4-flash-vision-exp` | 旧名（已下线，转由 V4.1 Flash 服务） | 1M     | 384K     | 文本 + 图像 | off/low/high/max |

官方说明：旧模型名仍可调用，请求由 DeepSeek-V4.1-Flash 提供服务并按 Flash 价格计费，所以两个旧名保留在目录中。

**思考档位**：DeepSeek 思考模式默认开启、effort 默认 `high`，开关与档位通过 `thinking: {type: enabled|disabled}` + `reasoning_effort` 控制（[思考模式文档](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)）。本扩展只暴露 1:1 映射的档位：low→low、high→high、max→max；官方映射表中 minimal/medium/xhigh 会折算到其他档位（minimal→low、medium/xhigh→high），为避免计费误解不开放，pi 会把旧的对应设置钳制到受支持档位。V4 Pro 上游只接受 high/max 两个档位。

**图片输入**：`deepseek-flash` 与 `deepseek-v4-flash-vision-exp` 支持文本与图片输入（[视觉理解文档](https://api-docs.deepseek.com/zh-cn/guides/vision)）；V4 Pro 不支持图片。

## 认证

凭据优先级：`DEEPSEEK_API_KEY` 环境变量 > pi 认证文件中 `deepseek` 条目（`/login` 粘贴 API Key 写入 `{ type: "api_key", key }`）。

### 登录对话框

在 pi 中执行 `/login`，选择 **DeepSeek**，粘贴从 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 创建的 API Key 即可。

### 环境变量

```sh
export DEEPSEEK_API_KEY="sk-..."
```

## 使用

用 `/model` 选择 `deepseek/` 前缀的模型；终端可列出模型：

```sh
pi --list-models deepseek
```

非交互模式：

```sh
pi -p "hello" --model deepseek/deepseek-flash
```

## 命令

| 命令                | 作用                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `/deepseek-usage`   | 查询账户额度：可用状态 + 每种货币的总余额 / 赠金 / 充值余额（官方 `GET /user/balance`）；主 agent 生成期间也可查询，5 秒防抖                   |
| `/deepseek-refresh` | 在线拉取模型列表（官方 `GET /models`，返回上下文窗口、输出上限、输入模态、effort 档位等元数据）并报告新增/移除；失败回退内置静态目录；5 秒防抖 |

余额输出示例：

```text
DeepSeek balance: available
  CNY  total 110.00 · granted 10.00 · topped-up 100.00
  USD  total 5.00 · granted 0.00 · topped-up 5.00
```

余额不足时首行显示 `insufficient balance for API calls`；字段缺失显示 `unavailable`，不伪造零值。TUI 使用带 `customMessageBg` 主题背景色的持久卡片，通过 `appendEntry` 即时显示，不进入主任务的 steering 队列，也不写入 LLM 上下文；RPC 使用即时通知。

## 环境变量

| 变量                | 用途                            | 默认值                     |
| ------------------- | ------------------------------- | -------------------------- |
| `DEEPSEEK_API_KEY`  | DeepSeek API Key（最高优先级）  | 无                         |
| `DEEPSEEK_API_BASE` | API 根地址覆盖（代理 / 测试用） | `https://api.deepseek.com` |

`DEEPSEEK_API_BASE` 主要用于测试与本地 mock。修改后需 `/reload` 或重启生效（baseUrl 在扩展加载时确定）。

## 离线行为

模型列表以扩展内置的静态目录为兜底：在线拉取失败、`/deepseek-refresh` 端点不可用或离线启动时，均回退到静态目录并给出提示，对话能力不受影响。

## 开发

```sh
npm install
npm test                 # typecheck + 全部单元测试 + pi 真实实例端到端测试
```

端到端测试 `tests/test-pi-local.mjs` 需要 `pi` 在 `PATH` 上，缺失时自动跳过。

## 许可证与致谢

MIT，见 [LICENSE](LICENSE)。结构与测试方式移植自 [pi-kimi-provider](https://github.com/baozi-2019/pi-kimi-provider)；模型规格、余额接口与模型列表接口以 [DeepSeek API 官方文档](https://api-docs.deepseek.com/zh-cn/)为准。

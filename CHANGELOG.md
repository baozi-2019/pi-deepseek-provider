# Changelog

## 0.1.0 (2026-11-01)

- 初始版本：自研 provider `deepseek`（OpenAI Chat Completions 协议，baseUrl `{DEEPSEEK_API_BASE|https://api.deepseek.com}`），与 pi 内置 `deepseek` provider 同名组合，模型目录由扩展接管
- 认证：复用内置凭据链——`DEEPSEEK_API_KEY` 环境变量 + `/login` 粘贴 API Key 写入的 auth.json `deepseek` 条目
- 静态模型目录 4 个：`deepseek-flash`（V4.1 Flash，文本+图像）、`deepseek-v4-pro`（V4 Pro，文本）、旧名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`（已下线，由 V4.1 Flash 服务）
- 思考档位：off/low/high/max 按官方映射表开放 1:1 档位（V4 Pro 仅 high/max），`thinking` 开关 + `reasoning_effort` 由 pi 的 deepseek thinkingFormat 发出
- `/deepseek-balance`：账户余额查询（官方 `GET /user/balance`），可用状态 + CNY/USD 总余额/赠金/充值余额，5 秒防抖，主 agent 生成期间也可查询
- `/deepseek-refresh`：在线刷新模型列表（官方 `GET /models`，解析上下文窗口/输出上限/输入模态/effort 档位元数据），未知模型生成保守的通用定义，静态目录兜底

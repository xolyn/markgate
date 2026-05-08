# MarkGate

MarkGate 是一个小型 Cloudflare Worker 网关，可将网页转换为 Markdown，降低captcha的干扰。

它的目标很简单：把多个 URL-to-Markdown 云服务接在一个统一入口后面，按优先级自动 fallback。某个服务失败、限流、没额度时，请求会继续尝试下一个引擎，最终始终以统一 JSON 结构返回。

## 项目目的

很多网页转 Markdown 服务都有免费额度，但单个服务容易遇到限流、余额不足、动态网页解析失败、网络波动等问题。MarkGate 把这些服务串成一个轻量网关：

- 一个 HTTP API，把任意网页转成 Markdown
- 一个 MCP endpoint，给 AI 客户端暴露同一个转换工具
- 多引擎 fallback，提高成功率和免费额度利用率
- 单文件 Worker，方便部署、复制和继续加新引擎

## 支持的引擎

当前代码支持：

| Engine | 作用 | 默认环境变量 |
| --- | --- | --- |
| `jina` | Jina Reader | `JINA_API_KEY` |
| `neoreader` | NeoReader URL-to-Markdown | `NEOREADER_API_KEY` |
| `unweb` | UnWeb URL conversion | `UNWEB_API_KEY` |
| `firecrawl` | Firecrawl scrape markdown | `FIRECRAWL_API_KEY` |
| `serply` | Serply markdown request | `SERPLY_API_KEY` |
| `cloudflare` | Cloudflare Browser Rendering markdown | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` |

默认 fallback 顺序在 `worker.js` 顶部：

```js
const ENGINE_PRIORITY = {
  jina: 0,
  neoreader: 1,
  unweb: 2,
  firecrawl: 3,
  serply: 4,
  cloudflare: 5,
};
```

数字越小，优先级越高。想调整消耗顺序，只改这个对象即可。

## 部署

创建 Cloudflare Worker 后，把 `worker.js` 作为 Worker 入口部署。

需要把对应服务的密钥写到 Worker 环境变量或 secrets 中。至少配置一个引擎的密钥即可运行；配置越多，fallback 越完整。

示例 secrets：

```bash
JINA_API_KEY
NEOREADER_API_KEY
UNWEB_API_KEY
FIRECRAWL_API_KEY
SERPLY_API_KEY
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
```

可选 endpoint 覆盖：

```txt
JINA_READER_BASE_URL=https://r.jina.ai/
NEOREADER_API_URL=https://api.neoreader.dev/
UNWEB_API_URL=https://api.unweb.info/api/convert/url
FIRECRAWL_API_URL=https://api.firecrawl.dev/v1/scrape
SERPLY_API_URL=https://api.serply.io/v1/request
```

可选超时覆盖：

```txt
JINA_TIMEOUT_MS=30000
NEOREADER_TIMEOUT_MS=30000
UNWEB_TIMEOUT_MS=30000
FIRECRAWL_TIMEOUT_MS=30000
SERPLY_TIMEOUT_MS=30000
CLOUDFLARE_TIMEOUT_MS=30000
```

## HTTP API

只有一个普通 HTTP API：根路径。

### Path 形式

```bash
GET https://your-markgate-worker.example.com/https://example.com
```

### Query 形式

```bash
GET https://your-markgate-worker.example.com?engine={engine}&url={url}
```

> 建议将 `engine` 参数写在前面来避免url中的ampersand造成混淆

### 指定引擎

普通 HTTP API 支持指定 engine。指定后不会走 fallback。

```bash
GET https://your-markgate-worker.example.com/?url=https://example.com&engine=jina/neoreader/unweb/firecrawl/serply/cloudflare
```

### 成功响应

```json
{
  "engine": "jina",
  "markdown": "# Example Domain\n\nThis domain is for use in illustrative examples..."
}
```

### 失败响应

```json
{
  "error": "Conversion failed",
  "message": "All engines failed.",
  "failures": [
    {
      "engine": "jina",
      "message": "Jina failed with 429: ..."
    }
  ]
}
```

## MCP

MCP endpoint：

```bash
POST https://your-markgate-worker.example.com/mcp
```

暴露一个工具：

```txt
convert_url_to_markdown
```

工具只允许一个参数：

```json
{
  "url": "https://example.com"
}
```

MCP 工具不允许指定 engine，会始终按 `ENGINE_PRIORITY` 自动 fallback。

### MCP tools/call 示例

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "convert_url_to_markdown",
    "arguments": {
      "url": "https://example.com"
    }
  }
}
```

返回内容是一个 JSON 字符串，包含：

```json
{
  "engine": "jina",
  "markdown": "..."
}
```

## 大概可用量

免费额度会变，下面只是粗略估算，适合做容量预期，不适合当 SLA。

如果配置了全部引擎，首月大概可以支持：

```txt
约 3,000 - 8,000 个网页
```

更保守的长期月常态：

```txt
约 2,000 - 5,000 个网页/月
```

估算来源：

| Engine | 粗略免费量级 | 估算贡献 |
| --- | ---: | ---: |
| Jina | 按 token 计量 | 约 1,000 - 3,300 页 |
| NeoReader | 约 500 requests/month | 约 500 页/月 |
| UnWeb | 约 100 conversions/month | 约 100 页/月 |
| Firecrawl | 免费/试用 credits | 约 500 页，视账号额度 |
| Serply | 免费层不完全透明 | 暂按约 100 页/月 |
| Cloudflare Browser Rendering | 按浏览器运行时间计 | 约 900 - 3,600 页/月 |

实际容量会受页面长度、动态渲染时间、各服务限流策略、失败率影响。Cloudflare 作为最后兜底时，简单静态页消耗少，复杂 SPA 可能消耗明显更多浏览器时间。

## 添加新引擎

新增服务时通常只需要三步：

1. 在 `ENGINE_PRIORITY` 里加入名字和优先级。
2. 在 `ENGINE_HANDLERS` 里映射到转换函数。
3. 新增一个 `convertWithXxx(url, env, options)` 函数，返回：

```js
{
  engine: "xxx",
  markdown: "..."
}
```

HTTP API 和 MCP 工具会自动使用新的 fallback 顺序。

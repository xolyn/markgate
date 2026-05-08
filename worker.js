const ENGINE_PRIORITY = {
  neoreader: 0,
  jina: 1,
  unweb: 2,
  firecrawl: 3,
  serply: 4,
  cloudflare: 5,
};

const ENGINE_HANDLERS = {
  jina: convertWithJina,
  neoreader: convertWithNeoReader,
  unweb: convertWithUnWeb,
  firecrawl: convertWithFirecrawl,
  serply: convertWithSerply,
  cloudflare: convertWithCloudflare,
};

const DEFAULT_TIMEOUT_MS = 30000;

const MCP_TOOLS = [
  {
    name: "convert_url_to_markdown",
    description: `
      Convert a web page URL into Markdown. The gateway automatically uses the configured fallback order. Only pass the target URL; engine selection is intentionally not exposed.
      将网页 URL 转换成 Markdown。网关会自动按配置的 fallback 优先级转换。只允许传入目标 URL，不支持指定 engine。
    `,
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "The absolute http:// or https:// URL to convert into Markdown.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

export default {
  async fetch(request, env, ctx) {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === "/mcp") {
      return handleMCP(request, env);
    }

    if (request.method !== "GET") {
      return jsonResponse(
        {
          error: "Method not allowed",
          message: "Only GET is supported.",
        },
        405,
        { Allow: "GET" },
      );
    }

    try {
      const targetUrl = getTargetUrl(requestUrl);
      const requestedEngine = normalizeEngine(
        requestUrl.searchParams.get("engine"),
      );

      if (!targetUrl) {
        return jsonResponse(
          {
            error: "Missing url",
            message:
              "Pass a target URL as /https://example.com or ?url=https://example.com.",
          },
          400,
        );
      }

      if (!isHttpUrl(targetUrl)) {
        return jsonResponse(
          {
            error: "Invalid url",
            message: "Only http:// and https:// URLs are supported.",
          },
          400,
        );
      }

      if (requestedEngine && !ENGINE_HANDLERS[requestedEngine]) {
        return jsonResponse(
          {
            error: "Unsupported engine",
            message: `Supported engines: ${Object.keys(ENGINE_HANDLERS).join(", ")}.`,
          },
          400,
        );
      }

      const extraOptions = paramsToOptions(requestUrl.searchParams, [
        "url",
        "engine",
      ]);
      const result = requestedEngine
        ? await runSingleEngine(requestedEngine, targetUrl, env, extraOptions)
        : await runFallbackEngines(targetUrl, env, extraOptions);

      return jsonResponse({
        engine: result.engine,
        markdown: result.markdown,
      });
    } catch (error) {
      return jsonResponse(
        {
          error: "Conversion failed",
          message: error.message || String(error),
          failures: error.failures,
        },
        502,
      );
    }
  },
};

async function handleMCP(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        Allow: "POST, OPTIONS",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return mcpResponse(jsonrpcError(null, -32700, "Parse error"), 400);
  }

  const { id, method, params } = body;

  try {
    if (method === "initialize") {
      return mcpResponse(
        jsonrpc(id, {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "url2md-mcp",
            version: "1.0.0",
          },
        }),
      );
    }

    if (method === "notifications/initialized") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    if (method === "tools/list") {
      return mcpResponse(jsonrpc(id, { tools: MCP_TOOLS }));
    }

    if (method === "tools/call") {
      const { name, arguments: args = {} } = params ?? {};

      try {
        const output = await callMCPTool(name, args, env);
        return mcpResponse(
          jsonrpc(id, {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          }),
        );
      } catch (error) {
        return mcpResponse(
          jsonrpc(id, {
            content: [
              {
                type: "text",
                text: `Error: ${error.message || String(error)}`,
              },
            ],
            isError: true,
          }),
        );
      }
    }

    return mcpResponse(
      jsonrpcError(id, -32601, `Method not found: ${method}`),
      404,
    );
  } catch (error) {
    return mcpResponse(
      jsonrpcError(id, -32603, error.message || String(error)),
      500,
    );
  }
}

async function callMCPTool(name, args, env) {
  if (name !== "convert_url_to_markdown") {
    throw new Error(`Unknown tool: ${name}`);
  }

  validateMCPConvertArgs(args);

  return runFallbackEngines(args.url.trim(), env, {});
}

function validateMCPConvertArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("arguments must be an object with exactly one field: url.");
  }

  const keys = Object.keys(args);
  if (keys.length !== 1 || keys[0] !== "url") {
    throw new Error("Only the url argument is allowed.");
  }

  if (typeof args.url !== "string" || args.url.trim() === "") {
    throw new Error("url is required and must be a non-empty string.");
  }

  if (!isHttpUrl(args.url.trim())) {
    throw new Error("url must be an absolute http:// or https:// URL.");
  }
}

async function runSingleEngine(engine, url, env, options) {
  const handler = ENGINE_HANDLERS[engine];
  if (!handler) {
    throw new Error(`Unsupported engine: ${engine}`);
  }

  return handler(url, env, options);
}

async function runFallbackEngines(url, env, options) {
  const engines = Object.entries(ENGINE_PRIORITY)
    .sort(([, a], [, b]) => a - b)
    .map(([engine]) => normalizeEngine(engine))
    .filter((engine) => ENGINE_HANDLERS[engine]);

  const failures = [];

  for (const engine of engines) {
    try {
      return await ENGINE_HANDLERS[engine](url, env, options);
    } catch (error) {
      failures.push({
        engine,
        message: error.message || String(error),
      });
    }
  }

  const error = new Error("All engines failed.");
  error.failures = failures;
  throw error;
}

async function convertWithJina(url, env, options = {}) {
  const baseUrl = env.JINA_READER_BASE_URL || "https://r.jina.ai/";
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/${url}`;
  const headers = {
    Accept: "application/json",
  };

  if (env.JINA_API_KEY) {
    headers.Authorization = `Bearer ${env.JINA_API_KEY}`;
  }

  addOptionalHeader(headers, "X-Timeout", options.timeout || env.JINA_TIMEOUT);
  addOptionalHeader(
    headers,
    "X-Respond-With",
    options.respondWith || env.JINA_RESPOND_WITH || "markdown",
  );
  addOptionalHeader(
    headers,
    "X-Target-Selector",
    options.targetSelector || env.JINA_TARGET_SELECTOR,
  );
  addOptionalHeader(
    headers,
    "X-Wait-For-Selector",
    options.waitForSelector || env.JINA_WAIT_FOR_SELECTOR,
  );
  addOptionalHeader(
    headers,
    "X-With-Images-Summary",
    options.withImagesSummary || env.JINA_WITH_IMAGES_SUMMARY,
  );
  addOptionalHeader(
    headers,
    "X-With-Links-Summary",
    options.withLinksSummary || env.JINA_WITH_LINKS_SUMMARY,
  );

  const response = await fetchWithTimeout(
    endpoint,
    {
      headers,
    },
    Number(options.timeoutMs || env.JINA_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  );

  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Jina failed with ${response.status}: ${truncate(bodyText)}`,
    );
  }

  const markdown = parseJinaMarkdown(
    bodyText,
    response.headers.get("content-type"),
  );
  assertMarkdown(markdown, "Jina");

  return {
    engine: "jina",
    markdown,
  };
}

async function convertWithCloudflare(url, env, options = {}) {
  if (!env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error("Missing CLOUDFLARE_ACCOUNT_ID.");
  }

  if (!env.CLOUDFLARE_API_TOKEN) {
    throw new Error("Missing CLOUDFLARE_API_TOKEN.");
  }

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/markdown`;
  const payload = {
    url,
  };

  const waitUntil = options.waitUntil || env.CLOUDFLARE_WAIT_UNTIL;
  if (waitUntil) {
    payload.gotoOptions = {
      waitUntil,
    };
  }

  if (options.userAgent || env.CLOUDFLARE_USER_AGENT) {
    payload.userAgent = options.userAgent || env.CLOUDFLARE_USER_AGENT;
  }

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    Number(
      options.timeoutMs || env.CLOUDFLARE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS,
    ),
  );

  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Cloudflare failed with ${response.status}: ${truncate(bodyText)}`,
    );
  }

  const markdown = parseCloudflareMarkdown(bodyText);
  assertMarkdown(markdown, "Cloudflare");

  return {
    engine: "cloudflare",
    markdown,
  };
}

async function convertWithNeoReader(url, env, options = {}) {
  if (!env.NEOREADER_API_KEY) {
    throw new Error("Missing NEOREADER_API_KEY.");
  }

  const baseUrl = env.NEOREADER_API_URL || "https://api.neoreader.dev/";
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/${url}`;
  const response = await fetchWithTimeout(
    endpoint,
    {
      headers: {
        "X-API-Key": env.NEOREADER_API_KEY,
      },
    },
    Number(options.timeoutMs || env.NEOREADER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  );

  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(
      `NeoReader failed with ${response.status}: ${truncate(bodyText)}`,
    );
  }

  const markdown = bodyText;
  assertMarkdown(markdown, "NeoReader");

  return {
    engine: "neoreader",
    markdown,
  };
}

async function convertWithUnWeb(url, env, options = {}) {
  if (!env.UNWEB_API_KEY) {
    throw new Error("Missing UNWEB_API_KEY.");
  }

  const endpoint =
    env.UNWEB_API_URL || "https://api.unweb.info/api/convert/url";
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.UNWEB_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
      }),
    },
    Number(options.timeoutMs || env.UNWEB_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  );

  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(
      `UnWeb failed with ${response.status}: ${truncate(bodyText)}`,
    );
  }

  const markdown = parseUnWebMarkdown(bodyText);
  assertMarkdown(markdown, "UnWeb");

  return {
    engine: "unweb",
    markdown,
  };
}

async function convertWithFirecrawl(url, env, options = {}) {
  if (!env.FIRECRAWL_API_KEY) {
    throw new Error("Missing FIRECRAWL_API_KEY.");
  }

  const endpoint =
    env.FIRECRAWL_API_URL || "https://api.firecrawl.dev/v1/scrape";
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.FIRECRAWL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
      }),
    },
    Number(options.timeoutMs || env.FIRECRAWL_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  );

  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Firecrawl failed with ${response.status}: ${truncate(bodyText)}`,
    );
  }

  const markdown = parseFirecrawlMarkdown(bodyText);
  assertMarkdown(markdown, "Firecrawl");

  return {
    engine: "firecrawl",
    markdown,
  };
}

async function convertWithSerply(url, env, options = {}) {
  if (!env.SERPLY_API_KEY) {
    throw new Error("Missing SERPLY_API_KEY.");
  }

  const endpoint = env.SERPLY_API_URL || "https://api.serply.io/v1/request";
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": env.SERPLY_API_KEY,
      },
      body: JSON.stringify({
        url,
        response_type: "markdown",
      }),
    },
    Number(options.timeoutMs || env.SERPLY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  );

  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Serply failed with ${response.status}: ${truncate(bodyText)}`,
    );
  }

  const markdown = parseSerplyMarkdown(bodyText);
  assertMarkdown(markdown, "Serply");

  return {
    engine: "serply",
    markdown,
  };
}

function getTargetUrl(requestUrl) {
  const queryUrl = requestUrl.searchParams.get("url");
  if (queryUrl) {
    return queryUrl.trim();
  }

  const path = requestUrl.pathname.replace(/^\/+/, "");
  if (!path) {
    return "";
  }

  return decodeURIComponent(path);
}

function normalizeEngine(engine) {
  return (engine || "").trim().toLowerCase();
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function paramsToOptions(searchParams, excludedKeys = []) {
  const excluded = new Set(excludedKeys);
  const options = {};

  for (const [key, value] of searchParams.entries()) {
    if (!excluded.has(key) && value !== "") {
      options[key] = value;
    }
  }

  return options;
}

function addOptionalHeader(headers, name, value) {
  if (value !== undefined && value !== null && value !== "") {
    headers[name] = String(value);
  }
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("Request timed out."),
    timeoutMs,
  );

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function parseJinaMarkdown(bodyText, contentType = "") {
  if (!contentType.includes("application/json")) {
    return bodyText;
  }

  const data = JSON.parse(bodyText);
  return data?.data?.content || data?.content || data?.result || bodyText;
}

function parseCloudflareMarkdown(bodyText) {
  const data = JSON.parse(bodyText);

  if (data.success === false) {
    const messages = [...(data.errors || []), ...(data.messages || [])]
      .map((item) => item.message || String(item))
      .filter(Boolean)
      .join("; ");
    throw new Error(messages || "Cloudflare returned success=false.");
  }

  return data.result || data.markdown || "";
}

function parseFirecrawlMarkdown(bodyText) {
  const data = parseJsonOrText(bodyText);

  if (data.success === false) {
    throw new Error(data.error || "Firecrawl returned success=false.");
  }

  return data?.data?.markdown || extractMarkdown(data);
}

function parseUnWebMarkdown(bodyText) {
  const data = JSON.parse(bodyText);
  return data.markdown || "";
}

function parseSerplyMarkdown(bodyText) {
  const data = parseJsonOrText(bodyText);

  if (data.error) {
    const message =
      typeof data.error === "string"
        ? data.error
        : data.error.message || JSON.stringify(data.error);
    throw new Error(message);
  }

  return extractMarkdown(data);
}

function parseJsonOrText(bodyText) {
  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}

function extractMarkdown(data) {
  if (typeof data === "string") {
    return data;
  }

  return (
    data?.markdown ||
    data?.data?.markdown ||
    data?.data?.content ||
    data?.result?.markdown ||
    data?.result?.content ||
    data?.result ||
    data?.content ||
    ""
  );
}

function assertMarkdown(markdown, engineName) {
  if (typeof markdown !== "string" || markdown.trim() === "") {
    throw new Error(`${engineName} returned empty markdown.`);
  }
}

function truncate(value, maxLength = 500) {
  if (!value || value.length <= maxLength) {
    return value || "";
  }

  return `${value.slice(0, maxLength)}...`;
}

function jsonrpc(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function jsonrpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

function mcpResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      ...headers,
    },
  });
}

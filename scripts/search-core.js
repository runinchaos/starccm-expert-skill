import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

const MAX_RESULTS = 12;
const TOOL_NAMES = ["starccm_doc_search", "starccm_doc_read", "starccm_doc_compare", "starccm_doc_research"];

const pluginConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    docsRoot: {
      type: "string",
      description: "Absolute path of the local STARCCP_DOCS directory.",
    },
    datasets: {
      type: "array",
      description: "Explicit STAR datasets. Prefer this over docsRoot when document folders vary by machine.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          version: { type: "string" },
          language: { type: "string" },
        },
        required: ["path", "version", "language"],
      },
    },
  },
};

const datasetCache = new Map();
const contentCache = new Map();
const nativeSearchMetaCache = new Map();
const catalogCache = new Map();

const STAR_CONTENT_SELECTORS = [
  "main article",
  ".wh_topic_content main article",
  ".wh_topic_content main",
  ".wh_topic_content article",
  ".wh_topic_content",
  "main",
  "[role='main'] article",
  "[role='main']",
  "article",
];

const STAR_REMOVE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "nav",
  "aside",
  "header",
  "footer",
  "form",
  ".wh_header",
  ".wh_top_menu_and_indexterms_link",
  ".search_container",
  ".wh_breadcrumb",
  ".wh_tools",
  ".wh_right_tools",
  ".wh_publication_toc",
  ".wh_topic_toc",
  ".wh_child_links",
  ".wh_related_links",
  ".wh_footer",
  ".wh_tile",
  ".wh_main_page_toc",
  ".wh_content_area > .row > .col-md-3",
  ".share",
  ".share-links",
  ".social-share",
  ".related-links",
  ".related-articles",
  ".support",
  ".support-center",
  ".cookie-banner",
  ".cookie-consent",
  "[role='navigation']",
  "[aria-label*='breadcrumb' i]",
  "[aria-label*='share' i]",
  "[aria-label*='navigation' i]",
];

const STAR_NOISE_PATTERNS = [
  /^jump to (main content|search results)$/i,
  /^search ?-->? ?home$/i,
  /^home$/i,
  /^share$/i,
  /^email$/i,
  /^link: copied$/i,
  /^copy breadcrumb: copied$/i,
  /^need support\??$/i,
  /^support center$/i,
  /^follow us$/i,
  /^corporate information$/i,
  /^privacy policy$/i,
  /^cookies policy$/i,
  /^terms of use$/i,
  /^digital id$/i,
  /^unpublished work/i,
  /^on this page$/i,
  /^search results$/i,
];

const STAR_NOISE_CLASS_PATTERNS = [
  /\bbreadcrumb\b/i,
  /\bshare\b/i,
  /\btoc\b/i,
  /\bchild[-_ ]links?\b/i,
  /\brelated\b/i,
  /\bsupport\b/i,
  /\bfooter\b/i,
  /\bheader\b/i,
  /\bnavigation\b/i,
  /\btoolbar\b/i,
];

const RESEARCH_FACETS = [
  "definition",
  "classification",
  "selection",
  "setup",
  "requirements",
  "limitations",
  "version_diff",
];

const RESEARCH_STOP_TERMS = new Set([
  "什么",
  "是什么",
  "怎么",
  "怎么选",
  "如何",
  "如何选",
  "分别",
  "分别是什么",
  "区别",
  "差异",
  "比较",
  "哪些",
  "哪个",
  "是否",
  "一下",
  "please",
  "what",
  "how",
  "which",
  "compare",
  "difference",
  "versus",
  "vs",
]);

function resolveApiKey(input) {
  if (!input) return undefined;
  if (typeof input === "string") return input;
  if (input.source === "env") return process.env[input.id];
  return undefined;
}

function normalizeEndpoint(baseUrl, suffix) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) return "";
  if (base.endsWith(suffix)) return base;
  return `${base}${suffix}`;
}

function buildProviderHeaders(provider) {
  const headers = {
    "Content-Type": "application/json",
    ...(provider.headers || {}),
  };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  return headers;
}

function pickCompletionProvider(providers, log) {
  const entries = Object.entries(providers || {}).filter(([, provider]) => Array.isArray(provider?.models) && provider.models.length > 0);
  if (entries.length === 0) return null;
  entries.sort(([, a], [, b]) => {
    const aScore = (a.api === "openai-completions" ? 2 : 0) + (resolveApiKey(a.apiKey) ? 1 : 0);
    const bScore = (b.api === "openai-completions" ? 2 : 0) + (resolveApiKey(b.apiKey) ? 1 : 0);
    return bScore - aScore;
  });
  const [name, provider] = entries[0];
  const model = provider.models[0]?.id;
  if (!model || !provider.baseUrl) return null;
  log?.info?.(`[starccm-docs] host planner provider: ${name} -> ${model}`);
  return {
    name,
    baseUrl: provider.baseUrl,
    apiKey: resolveApiKey(provider.apiKey),
    api: provider.api,
    headers: provider.headers,
    model,
  };
}

function buildHostCompletionClient(api) {
  const providers = api?.config?.models?.providers;
  const provider = pickCompletionProvider(providers, api?.logger);
  if (!provider) return null;
  return {
    provider,
    async complete({ prompt, maxTokens = 700, temperature = 0 }) {
      const endpoint = normalizeEndpoint(provider.baseUrl, "/chat/completions");
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: buildProviderHeaders(provider),
        body: JSON.stringify({
          model: provider.model,
          messages: [{ role: "user", content: prompt }],
          temperature,
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`planner completion failed (${provider.name} ${resp.status}): ${body}`);
      }
      const json = await resp.json();
      const text = json?.choices?.[0]?.message?.content ?? "";
      return String(text || "");
    },
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeVersion(input) {
  if (!input) return "";
  const raw = String(input).trim();
  const match = raw.match(/(\d{2}\.\d{2})/);
  return match ? match[1] : raw;
}

function normalizeLanguage(input) {
  const raw = String(input || "").trim().toLowerCase();
  if (raw === "zh" || raw === "cn" || raw === "chinese") return "zh";
  if (raw === "en" || raw === "english") return "en";
  return raw;
}

function uniq(items) {
  return [...new Set(items.filter(Boolean))];
}

function scanCatalog(docsRoot) {
  const resolvedRoot = path.resolve(String(docsRoot || "").trim());
  if (!resolvedRoot) {
    throw new Error("STAR docs location is not configured. Provide datasets or docsRoot.");
  }
  if (catalogCache.has(resolvedRoot)) return catalogCache.get(resolvedRoot);
  const items = [];
  for (const name of fs.readdirSync(resolvedRoot, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const match = name.name.match(/^(en|zh)_STARCCMP_(\d{2}\.\d{2})$/);
    if (!match) continue;
    items.push({
      key: `${match[1]}::${match[2]}::${path.join(resolvedRoot, name.name)}`,
      language: match[1],
      version: match[2],
      folderName: name.name,
      dir: path.join(resolvedRoot, name.name),
    });
  }
  items.sort((a, b) => a.folderName.localeCompare(b.folderName));
  catalogCache.set(resolvedRoot, items);
  return items;
}

function normalizeCatalogEntries(entries = []) {
  const normalized = entries.map((entry) => {
    const dir = path.resolve(String(entry?.dir || entry?.path || "").trim());
    const version = normalizeVersion(entry?.version);
    const language = normalizeLanguage(entry?.language);
    const folderName = String(entry?.folderName || path.basename(dir) || "").trim();
    if (!dir || !version || !language) {
      throw new Error("Each STAR dataset must provide path, version, and language.");
    }
    return {
      key: `${language}::${version}::${dir}`,
      language,
      version,
      folderName,
      dir,
    };
  });
  normalized.sort((a, b) => a.folderName.localeCompare(b.folderName));
  return normalized;
}

function resolveCatalog({ docsRoot, catalogEntries } = {}) {
  if (Array.isArray(catalogEntries) && catalogEntries.length > 0) {
    return normalizeCatalogEntries(catalogEntries);
  }
  if (docsRoot) return scanCatalog(docsRoot);
  throw new Error("STAR docs location is not configured. Provide datasets or docsRoot.");
}

function hasCjk(text) {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

function parseTopicInfoString(topicInfoString) {
  const raw = String(topicInfoString || "");
  const pos1 = raw.indexOf("@@@");
  const pos2 = raw.lastIndexOf("@@@");
  if (pos1 === -1 || pos2 === -1 || pos2 < pos1) {
    return {
      relativePath: raw,
      title: "",
      shortDescription: "",
    };
  }
  return {
    relativePath: raw.slice(0, pos1),
    title: raw.slice(pos1 + 3, pos2),
    shortDescription: raw.slice(pos2 + 3),
  };
}

function loadSearchIndexVar(filePath, variableName) {
  return evaluateVarFile(filePath, [variableName]);
}

function normalizeContextLine(text) {
  const value = String(text || "").trim();
  if (!value || value === "null" || value === "...") return "";
  return value;
}

function catalogSignature(catalog = []) {
  return catalog
    .map((item) => `${item.language}:${item.version}:${item.dir}`)
    .sort()
    .join("||");
}

function loadNativeSearchMetaBundle({ docsRoot, catalogEntries, version, languages = [] }) {
  const normalizedLanguages = uniq((languages || []).map(normalizeLanguage)).filter((item) => item === "en" || item === "zh");
  const targets = resolveTargets({ docsRoot, catalogEntries }, [version], normalizedLanguages);
  const bundleKey = `${catalogSignature(targets)}::${version}::${normalizedLanguages.join(",")}`;
  if (nativeSearchMetaCache.has(bundleKey)) {
    return nativeSearchMetaCache.get(bundleKey);
  }

  const bundle = new Map();
  for (const target of targets) {
    const language = target.language;
    const indexDir = path.join(target.dir, "oxygen-webhelp", "app", "search", "index");
    const htmlInfoPath = path.join(indexDir, "htmlFileInfoList.js");
    const linkToParentPath = path.join(indexDir, "link-to-parent.js");
    if (!fs.existsSync(htmlInfoPath) || !fs.existsSync(linkToParentPath)) {
      continue;
    }

    const htmlFileInfoList = loadSearchIndexVar(htmlInfoPath, "htmlFileInfoList");
    const linkToParent = loadSearchIndexVar(linkToParentPath, "linkToParent");
    const pageMap = new Map();

    function breadcrumbNodesFor(topicIndex) {
      const nodes = [];
      let parentIndex = linkToParent?.[topicIndex];
      const seen = new Set();
      while (parentIndex !== undefined && parentIndex !== -1 && !seen.has(parentIndex)) {
        seen.add(parentIndex);
        const parentInfo = parseTopicInfoString(htmlFileInfoList[parentIndex]);
        const parentRelPath = String(parentInfo.relativePath || "");
        const parentPageId = path.basename(parentRelPath).replace(/\.html?$/i, "").split("#", 1)[0];
        if (parentInfo.title || parentPageId || parentRelPath) {
          nodes.unshift({
            title: parentInfo.title || "",
            pageId: parentPageId || "",
            relPath: parentRelPath,
          });
        }
        parentIndex = linkToParent?.[parentIndex];
      }
      return nodes;
    }

    htmlFileInfoList.forEach((entry, topicIndex) => {
      const topicInfo = parseTopicInfoString(entry);
      const relPath = String(topicInfo.relativePath || "");
      const pageId = path.basename(relPath).replace(/\.html?$/i, "").split("#", 1)[0];
      if (!pageId) return;
      const nextValue = {
        pageId,
        relPath,
        title: topicInfo.title || "",
        contextLine: normalizeContextLine(topicInfo.shortDescription),
        breadcrumb: breadcrumbNodesFor(topicIndex),
        language,
      };
      nextValue.breadcrumbTail = nextValue.breadcrumb.map((item) => item.title).filter(Boolean);
      const current = pageMap.get(pageId);
      if (!current) {
        pageMap.set(pageId, nextValue);
        return;
      }
      const currentScore = (current.contextLine ? 1 : 0) + current.breadcrumbTail.length;
      const nextScore = (nextValue.contextLine ? 1 : 0) + nextValue.breadcrumbTail.length;
      if (nextScore > currentScore) {
        pageMap.set(pageId, nextValue);
      }
    });

    bundle.set(language, pageMap);
  }

  nativeSearchMetaCache.set(bundleKey, bundle);
  return bundle;
}

function chooseNativeSearchMeta(item, bundle, languages = []) {
  const pageId = String(item?.pageId || "").trim();
  if (!pageId) return null;
  const requestedLanguages = uniq((languages || []).map(normalizeLanguage));
  const itemLanguages = uniq([...(item?.languages || []), item?.language].map(normalizeLanguage));
  const candidateLanguages = uniq([
    ...itemLanguages,
    ...(hasCjk(item?.title) ? ["zh", "en"] : ["en", "zh"]),
    ...requestedLanguages,
    "en",
    "zh",
  ]);
  const candidates = candidateLanguages
    .map((language) => bundle.get(language)?.get(pageId))
    .filter(Boolean);
  if (candidates.length === 0) return null;
  const exactTitle = candidates.find((candidate) => candidate.title && candidate.title === item.title);
  if (exactTitle) return exactTitle;
  return candidates[0];
}

function resolveTargets(source, versions, languages) {
  const catalog = typeof source === "string" || source === undefined
    ? resolveCatalog({ docsRoot: source })
    : resolveCatalog(source);
  const wantedVersions = uniq((versions || []).map(normalizeVersion));
  const wantedLanguages = uniq((languages || []).map(normalizeLanguage));
  return catalog.filter((item) => {
    const versionOk = wantedVersions.length === 0 || wantedVersions.includes(item.version);
    const languageOk = wantedLanguages.length === 0 || wantedLanguages.includes(item.language);
    return versionOk && languageOk;
  });
}

function evaluateVarFile(filePath, expectedVars) {
  const code = fs.readFileSync(filePath, "utf8");
  const context = {
    define(value) {
      if (typeof value === "function") {
        context.__defined = value();
      } else {
        context.__defined = value;
      }
    },
  };
  vm.createContext(context);
  vm.runInContext(code, context, { filename: filePath });
  for (const name of expectedVars) {
    if (context[name] !== undefined) return context[name];
  }
  if (context.__defined !== undefined) return context.__defined;
  throw new Error(`Failed to read ${expectedVars.join("/")} from ${filePath}`);
}

function parseTopicInfo(raw, index, datasetDir) {
  const pos1 = raw.indexOf("@@@");
  const pos2 = raw.lastIndexOf("@@@");
  const relPath = pos1 >= 0 ? raw.slice(0, pos1) : raw;
  const title = pos1 >= 0 && pos2 > pos1 ? raw.slice(pos1 + 3, pos2) : relPath;
  const description = pos2 > pos1 ? raw.slice(pos2 + 3) : "";
  return {
    id: index,
    relPath,
    absolutePath: path.join(datasetDir, relPath),
    title,
    description,
  };
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#160;/g, " ");
}

function stripHtml(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function cleanupContentText(text) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !STAR_NOISE_PATTERNS.some((pattern) => pattern.test(line)))
    .join("\n");
}

function stripHtmlPreservingBreaks(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|main|li|ul|ol|table|tr|td|th|h[1-6])>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim(),
  );
}

function stripNoiseNodes(root) {
  for (const selector of STAR_REMOVE_SELECTORS) {
    for (const node of root.querySelectorAll(selector)) {
      node.remove();
    }
  }
  for (const element of root.querySelectorAll("*")) {
    const className = element.getAttribute("class") || "";
    const id = element.getAttribute("id") || "";
    const ariaLabel = element.getAttribute("aria-label") || "";
    const text = (element.textContent || "").trim();
    const fingerprint = `${className} ${id} ${ariaLabel}`;
    if (STAR_NOISE_CLASS_PATTERNS.some((pattern) => pattern.test(fingerprint))) {
      element.remove();
      continue;
    }
    if (text && text.length <= 80 && STAR_NOISE_PATTERNS.some((pattern) => pattern.test(text))) {
      element.remove();
    }
  }
}

function extractTextFromNode(node) {
  if (!node) return "";
  return cleanupContentText(stripHtmlPreservingBreaks(node.innerHTML || ""));
}

function stripNoiseHtml(fragment) {
  let cleaned = fragment;
  const blockPatterns = [
    /<script[\s\S]*?<\/script>/gi,
    /<style[\s\S]*?<\/style>/gi,
    /<header\b[\s\S]*?<\/header>/gi,
    /<footer\b[\s\S]*?<\/footer>/gi,
    /<nav\b[\s\S]*?<\/nav>/gi,
    /<aside\b[\s\S]*?<\/aside>/gi,
    /<div\b[^>]*class="[^"]*wh_breadcrumb[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
    /<div\b[^>]*class="[^"]*search_container[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
    /<div\b[^>]*class="[^"]*wh_tools[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
    /<div\b[^>]*class="[^"]*wh_right_tools[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
    /<div\b[^>]*class="[^"]*wh_topic_toc[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
    /<div\b[^>]*class="[^"]*wh_child_links[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
    /<div\b[^>]*class="[^"]*wh_related_links[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
    /<div\b[^>]*class="[^"]*share[^"]*"[^>]*>[\s\S]*?<\/div>/gi,
  ];
  for (const pattern of blockPatterns) {
    cleaned = cleaned.replace(pattern, " ");
  }
  return cleaned;
}

function extractFastStructuredTextFromHtml(html) {
  const matches = [
    html.match(/<main\b[^>]*>\s*<article\b[^>]*>([\s\S]*?)<\/article>\s*<\/main>/i),
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i),
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i),
    html.match(/<div\b[^>]*class="[^"]*wh_topic_content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i),
  ];
  for (const match of matches) {
    if (!match?.[1]) continue;
    const text = cleanupContentText(stripHtmlPreservingBreaks(stripNoiseHtml(match[1])));
    if (text.length >= 400) {
      return {
        text,
        method: "fast-structured",
      };
    }
  }
  return null;
}

function tryStructuredContentExtraction(html) {
  const dom = new JSDOM(html);
  const { document } = dom.window;
  stripNoiseNodes(document);

  for (const selector of STAR_CONTENT_SELECTORS) {
    const candidate = document.querySelector(selector);
    if (!candidate) continue;
    const clone = candidate.cloneNode(true);
    stripNoiseNodes(clone);
    const text = extractTextFromNode(clone);
    if (text.length >= 400) {
      return {
        text,
        method: `structured:${selector}`,
      };
    }
  }

  return null;
}

function tryReadabilityExtraction(html) {
  const dom = new JSDOM(html, { url: "https://local.starccm.docs/" });
  const reader = new Readability(dom.window.document);
  const parsed = reader.parse();
  if (!parsed?.content) return null;
  const text = cleanupContentText(stripHtmlPreservingBreaks(parsed.content));
  if (text.length < 200) return null;
  return {
    text,
    method: "readability",
  };
}

function extractMainTextFromHtml(html) {
  const fast = extractFastStructuredTextFromHtml(html);
  if (fast) return fast;

  const structured = tryStructuredContentExtraction(html);
  if (structured) return structured;

  const readable = tryReadabilityExtraction(html);
  if (readable) return readable;

  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return {
    text: cleanupContentText(stripHtmlPreservingBreaks(bodyMatch ? bodyMatch[1] : html)),
    method: "body-fallback",
  };
}

function readExcerpt(filePath, query, tokens) {
  try {
    const text = readCleanText(filePath).text;
    const lowered = text.toLowerCase();
    const needles = [query.toLowerCase(), ...tokens.map((t) => t.toLowerCase())].filter(Boolean);
    let idx = -1;
    for (const needle of needles) {
      idx = lowered.indexOf(needle);
      if (idx >= 0) break;
    }
    if (idx < 0) idx = 0;
    const start = Math.max(0, idx - 120);
    const end = Math.min(text.length, idx + 240);
    return text.slice(start, end).trim();
  } catch {
    return "";
  }
}

function readCleanText(filePath) {
  const cached = contentCache.get(filePath);
  if (cached) return cached;
  const html = fs.readFileSync(filePath, "utf8");
  const extracted = extractMainTextFromHtml(html);
  contentCache.set(filePath, extracted);
  return extracted;
}

function resolveDocRef({ docsRoot, catalogEntries, version, language, relPath, folderName }) {
  const targets = resolveTargets({ docsRoot, catalogEntries }, version ? [version] : [], language ? [language] : []);
  if (folderName) {
    const direct = targets.find((item) => item.folderName === folderName);
    if (!direct) throw new Error(`Dataset not found: ${folderName}`);
    return {
      meta: direct,
      absolutePath: path.join(direct.dir, relPath),
    };
  }
  if (targets.length === 1) {
    return {
      meta: targets[0],
      absolutePath: path.join(targets[0].dir, relPath),
    };
  }
  if (targets.length === 0) {
    throw new Error(`No dataset matched version=${version || "*"} language=${language || "*"}`);
  }
  throw new Error("Multiple datasets matched; provide folderName or both version and language.");
}

function readDocument({ docsRoot, catalogEntries, version, language, relPath, folderName, query = "", maxChars = 12000 }) {
  if (!relPath) throw new Error("relPath is required");
  const { meta, absolutePath } = resolveDocRef({ docsRoot, catalogEntries, version, language, relPath, folderName });
  const extracted = readCleanText(absolutePath);
  const text = extracted.text;
  const trimmed = text.slice(0, Math.max(2000, Math.min(Number(maxChars) || 12000, 30000)));
  const dataset = loadDataset(meta);
  const doc = dataset.docs.find((item) => item.relPath === relPath);
  const tokens = tokenizeQuery(query);
  return {
    version: meta.version,
    language: meta.language,
    folderName: meta.folderName,
    relPath,
    absolutePath,
    title: doc?.title || path.basename(relPath),
    description: doc?.description || "",
    query,
    extractionMethod: extracted.method,
    excerpt: query ? readExcerpt(absolutePath, query, tokens) : "",
    text: trimmed,
    textLength: text.length,
  };
}

function tokenizeQuery(query) {
  const raw = String(query || "").trim();
  if (!raw) return [];
  const tokens = [];
  const wordMatches = raw.match(/[\p{L}\p{N}_.+:-]+/gu) || [];
  for (const token of wordMatches) {
    const normalized = token.toLowerCase().replace(/^["']+|["']+$/g, "");
    if (normalized.length >= 2) tokens.push(normalized);
  }
  const cjkMatches = raw.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) || [];
  for (const chunk of cjkMatches) {
    if (chunk.length >= 2) tokens.push(chunk.toLowerCase());
    if (chunk.length >= 3) {
      for (let i = 0; i < chunk.length - 1; i += 1) {
        tokens.push(chunk.slice(i, i + 2).toLowerCase());
      }
    }
  }
  return uniq(tokens);
}

function tokenizeQueryList(queries = []) {
  return uniq((queries || []).flatMap((query) => tokenizeQuery(query)));
}

function slugifyText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function parseLooseJson(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("empty planner response");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  const jsonText = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
  return JSON.parse(jsonText);
}

function detectResearchFacets(question) {
  const text = String(question || "").toLowerCase();
  const facets = new Set(["definition"]);
  if (/(什么|是什么|what is|overview|概述|解读|理解|模型|model)/i.test(text)) facets.add("classification");
  if (/(怎么选|如何选|区别|差异|比较|compare|versus|vs|tradeoff|适用场景)/i.test(text)) facets.add("selection");
  if (/(怎么设|如何设|workflow|设置|边界|节点|入口|参数|setup|configure)/i.test(text)) facets.add("setup");
  if (/(要求|前置|prereq|required|needs)/i.test(text)) facets.add("requirements");
  if (/(限制|代价|cost|性能|memory|runtime|注意|limitation|caveat)/i.test(text)) facets.add("limitations");
  if (/(版本|version|18\\.04|20\\.06|变化|changed|diff|比较|差异)/i.test(text)) facets.add("version_diff");
  return [...facets];
}

function normalizeResearchPhrase(phrase) {
  let text = String(phrase || "").trim();
  text = text.replace(/^[在对把将从给以用向里关于请问]+/u, "");
  text = text.replace(/(分别是什么|是什么|什么意思|怎么选|如何选|怎么设置|如何设置|有哪些|区别|差异|比较)$/u, "");
  return text.trim();
}

function extractKeyPhrases(question) {
  const raw = String(question || "").trim();
  const phrases = [];
  const quoted = raw.match(/["“](.+?)["”]/g) || [];
  for (const item of quoted) {
    const clean = item.replace(/^["“]|["”]$/g, "").trim();
    if (clean.length >= 2) phrases.push(clean);
  }
  const cjk = raw.match(/[\p{Script=Han}]{2,}/gu) || [];
  for (const item of cjk) {
    if (item.length >= 3) phrases.push(item);
  }
  const latin = raw.match(/[A-Za-z][A-Za-z0-9+_.:-]{1,}/g) || [];
  for (const item of latin) {
    if (item.length >= 2) phrases.push(item);
  }
  return uniq(
    phrases
      .map((item) => normalizeResearchPhrase(item))
      .filter((item) => item && item.length >= 2 && !RESEARCH_STOP_TERMS.has(item.toLowerCase())),
  ).slice(0, 8);
}

function splitQueriesByLanguage(phrases) {
  const zh = [];
  const en = [];
  for (const phrase of phrases || []) {
    if (/[\p{Script=Han}]/u.test(phrase)) zh.push(phrase);
    if (/[A-Za-z]/.test(phrase)) en.push(phrase);
  }
  return {
    zhQueries: uniq(zh).slice(0, 6),
    enQueries: uniq(en).slice(0, 6),
  };
}

function buildResearchQueries(question) {
  const phrases = extractKeyPhrases(question);
  if (phrases.length > 0) return phrases.slice(0, 8);
  const raw = String(question || "").trim();
  return raw ? [raw] : [];
}

function buildPlannerPrompt({ question, versions, languages }) {
  const versionText = uniq((versions || []).map(normalizeVersion)).filter(Boolean).join(", ") || "unspecified";
  const languageText = uniq((languages || []).map(normalizeLanguage)).filter(Boolean).join(", ") || "zh, en";
  return [
    "You are planning local documentation research over STAR-CCM+ docs.",
    "Do not answer the question. Produce bilingual search prompts for later retrieval.",
    "Return strict JSON only with keys:",
    '{"focus":"...", "facets":["..."], "zh_queries":["..."], "en_queries":["..."]}',
    "Rules:",
    "- zh_queries and en_queries must each contain 3 to 6 short search prompts.",
    "- Prompts should target STAR-CCM+ documentation structure: overview, reference, workflow, settings, limitations, version diff when relevant.",
    "- Preserve exact technical terms from the user question where possible.",
    "- Add English STAR-CCM+ terminology even if the question is Chinese.",
    "- Keep each query concise, suitable for offline doc search.",
    `Versions in scope: ${versionText}`,
    `Languages in scope: ${languageText}`,
    `User question: ${String(question || "").trim()}`,
  ].join("\n");
}

async function generatePlannerOutput({ api, question, versions, languages }) {
  const client = buildHostCompletionClient(api);
  if (!client) {
    return {
      source: "heuristic-fallback",
      focus: "",
      facets: detectResearchFacets(question),
      zhQueries: [],
      enQueries: [],
    };
  }
  try {
    const prompt = buildPlannerPrompt({ question, versions, languages });
    const text = await client.complete({ prompt, maxTokens: 700, temperature: 0 });
    const parsed = parseLooseJson(text);
    return {
      source: `host-model:${client.provider.model}`,
      focus: String(parsed?.focus || "").trim(),
      facets: uniq((parsed?.facets || []).map((item) => String(item || "").trim()).filter((item) => RESEARCH_FACETS.includes(item))),
      zhQueries: uniq((parsed?.zh_queries || []).map((item) => String(item || "").trim()).filter(Boolean)).slice(0, 6),
      enQueries: uniq((parsed?.en_queries || []).map((item) => String(item || "").trim()).filter(Boolean)).slice(0, 6),
      raw: text,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    api?.logger?.warn?.(`[starccm-docs] planner fallback: ${message}`);
    return {
      source: "heuristic-fallback",
      focus: "",
      facets: detectResearchFacets(question),
      zhQueries: [],
      enQueries: [],
      error: message,
    };
  }
}

function classifyDocType(item) {
  const title = String(item?.title || "").toLowerCase();
  if (/workflow|工作流/.test(title)) return "workflow";
  if (/reference|参考/.test(title)) return "reference";
  if (/theory|理论/.test(title)) return "theory";
  if (/material|材料属性/.test(title)) return "material";
  if (/field function|场函数/.test(title)) return "field_function";
  if (/solver|求解器/.test(title)) return "solver";
  return "topic";
}

function classifyDocTopics(item) {
  return [];
}

function withDocAnnotations(item) {
  return {
    ...item,
    docTypes: uniq([...(item.docTypes || []), classifyDocType(item)]),
  };
}

function structuralPriority(item) {
  const reasons = item?.structureReasons || [];
  let score = 0;
  if (reasons.some((reason) => String(reason).startsWith("parent-of:"))) score += 3;
  if (reasons.some((reason) => String(reason).startsWith("sibling-of:"))) score += 2;
  if (reasons.some((reason) => String(reason).startsWith("child-of:"))) score += 2;
  if (reasons.some((reason) => String(reason).startsWith("mention-of:"))) score += 1;
  if (reasons.includes("search-hit")) score += 1;
  return score;
}

function seedPriority(item) {
  const reasons = item?.structureReasons || [];
  if (reasons.includes("search-hit")) return 3;
  if (reasons.some((reason) => String(reason).startsWith("parent-of:"))) return 2;
  if (reasons.some((reason) => String(reason).startsWith("child-of:"))) return 2;
  if (reasons.some((reason) => String(reason).startsWith("sibling-of:"))) return 1;
  if (reasons.some((reason) => String(reason).startsWith("mention-of:"))) return 1;
  return 0;
}

function createResearchPlan({ question, versions, languages, plannerOutput = null }) {
  const facets = uniq([...(plannerOutput?.facets || []), ...detectResearchFacets(question)]);
  const keyPhrases = extractKeyPhrases(question);
  const topics = keyPhrases.length > 0 ? keyPhrases : [String(question || "").trim()].filter(Boolean);
  const fallbackSplit = splitQueriesByLanguage(keyPhrases);
  const zhQueries = uniq([...(plannerOutput?.zhQueries || []), ...fallbackSplit.zhQueries].filter(Boolean)).slice(0, 6);
  const enQueries = uniq([...(plannerOutput?.enQueries || []), ...fallbackSplit.enQueries].filter(Boolean)).slice(0, 6);
  const heuristicQueries = buildResearchQueries(question);
  const queries = zhQueries.length > 0 || enQueries.length > 0
    ? uniq([...zhQueries, ...enQueries]).slice(0, 12)
    : heuristicQueries;
  return {
    id: `research_${slugifyText(question)}_${Date.now()}`,
    question: String(question || "").trim(),
    versions: uniq((versions || []).map(normalizeVersion)).filter(Boolean),
    languages: uniq((languages || []).map(normalizeLanguage)).filter(Boolean),
    planner: {
      source: plannerOutput?.source || "heuristic-fallback",
      focus: plannerOutput?.focus || "",
      error: plannerOutput?.error || "",
    },
    topics,
    facets,
    keyPhrases,
    zhQueries,
    enQueries,
    queries,
    queryStrategy: {
      mode: "plan-first",
      source: zhQueries.length > 0 || enQueries.length > 0 ? "planned-keywords" : "fallback-keyphrases",
      notes: [
        "Do not search the raw user question first unless no usable planned keywords exist.",
        "Search terms are generated from the plan before retrieval starts.",
      ],
    },
    stopConditions: [
      "Planner has expanded the question into bilingual search prompts before retrieval starts.",
      "Every major structural cluster has at least one representative read.",
      "The relevant facets for the question are covered by evidence within the cluster set.",
      "No major evidence gaps remain for the user intent.",
    ],
  };
}

function appendPlanQueries(plan, extraQueries = []) {
  const mergedQueries = uniq([...(plan.queries || []), ...(extraQueries || [])].filter(Boolean)).slice(0, 20);
  const split = splitQueriesByLanguage(mergedQueries);
  return {
    ...plan,
    queries: mergedQueries,
    zhQueries: uniq([...(plan.zhQueries || []), ...(split.zhQueries || [])]).slice(0, 10),
    enQueries: uniq([...(plan.enQueries || []), ...(split.enQueries || [])]).slice(0, 10),
  };
}

function addSurveyCandidate(seen, item, patch = {}) {
  const key = `${item.folderName}/${item.relPath}`;
  const prior = seen.get(key);
  const merged = withDocAnnotations({
    ...(prior || {}),
    ...item,
    surveyScore: Math.max(Number(prior?.surveyScore || 0), Number(item.surveyScore || item.score || 0)) + Number(patch.scoreDelta || 0),
    matchedQueries: uniq([...(prior?.matchedQueries || []), ...(item.matchedQueries || []), ...(patch.matchedQueries || [])]),
    structureReasons: uniq([...(prior?.structureReasons || []), ...(item.structureReasons || []), ...(patch.structureReasons || [])]),
    parentId: item.parentId ?? prior?.parentId ?? null,
    parentRelPath: item.parentRelPath ?? prior?.parentRelPath ?? "",
    parentTitle: item.parentTitle ?? prior?.parentTitle ?? "",
    childIds: item.childIds ?? prior?.childIds ?? [],
  });
  seen.set(key, merged);
}

function buildDocRecord(dataset, docId, seed = {}) {
  const doc = dataset.docs[docId];
  if (!doc) return null;
  return withDocAnnotations({
    docId: doc.id,
    version: dataset.version,
    language: dataset.language,
    folderName: dataset.folderName,
    title: doc.title,
    description: doc.description,
    relPath: doc.relPath,
    absolutePath: doc.absolutePath,
    parentId: doc.parentId,
    parentRelPath: doc.parentRelPath,
    parentTitle: doc.parentTitle,
    childIds: doc.childIds,
    score: 0,
    surveyScore: 0,
    matchedQueries: [],
    structureReasons: [],
    ...seed,
  });
}

function buildDocNeighborRecord(dataset, source, docId, relation, weight) {
  return buildDocRecord(dataset, docId, {
    matchedQueries: source.matchedQueries,
    structureReasons: [`${relation}:${source.relPath}`],
    surveyScore: Math.max(1, Math.round((source.surveyScore || source.score || 1) * weight)),
  });
}

function findMentionNeighbors(dataset, item, seen, limit = 4) {
  const queryTokens = uniq([
    ...buildTitleTerms(item.title || ""),
    ...buildTitleTerms(item.parentTitle || ""),
    ...tokenizeQuery(item.description || ""),
  ]).filter((token) => token.length >= 2 && !dataset.stopwords.has(token));
  const scored = [];
  for (const token of queryTokens.slice(0, 16)) {
    for (const docId of dataset.titleTokenIndex?.get(token) || []) {
      if (docId === item.docId || seen.has(docId)) continue;
      const doc = dataset.docs[docId];
      if (!doc?.title) continue;
      let score = 0;
      const docTerms = buildTitleTerms(doc.title);
      for (const candidateToken of queryTokens) {
        if (docTerms.has(candidateToken)) score += 1;
      }
      if (score <= 0) continue;
      scored.push({ docId, score });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .filter((entry, index, arr) => arr.findIndex((x) => x.docId === entry.docId) === index)
    .slice(0, limit)
    .map((entry) => buildDocNeighborRecord(dataset, item, entry.docId, "mention-of", 0.18))
    .filter(Boolean);
}

function expandStructuralNeighborhood(dataset, candidates, options = {}) {
  const maxDepth = Math.min(Math.max(Number(options.maxDepth || 3), 1), 4);
  const maxFrontier = Math.min(Math.max(Number(options.maxFrontier || 12), 1), 24);
  const extra = [];
  const seen = new Set(candidates.map((item) => item.docId));
  let frontier = candidates
    .slice()
    .sort((a, b) => (b.surveyScore || b.score || 0) - (a.surveyScore || a.score || 0))
    .slice(0, maxFrontier);

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const nextFrontier = [];
    for (const item of frontier) {
      if (Number.isInteger(item.parentId) && item.parentId >= 0 && !seen.has(item.parentId)) {
        const parent = buildDocNeighborRecord(dataset, item, item.parentId, "parent-of", 0.45);
        if (parent) {
          extra.push(parent);
          nextFrontier.push(parent);
          seen.add(parent.docId);
        }
      }
      if (Array.isArray(item.childIds)) {
        for (const childId of item.childIds.slice(0, 4)) {
          if (seen.has(childId)) continue;
          const child = buildDocNeighborRecord(dataset, item, childId, "child-of", 0.22);
          if (child) {
            extra.push(child);
            nextFrontier.push(child);
            seen.add(child.docId);
          }
        }
      }
      if (Number.isInteger(item.parentId) && item.parentId >= 0) {
        const parent = dataset.docs[item.parentId];
        const siblings = (parent?.childIds || []).filter((docId) => docId !== item.docId);
        for (const siblingId of siblings.slice(0, 6)) {
          if (seen.has(siblingId)) continue;
          const sibling = buildDocNeighborRecord(dataset, item, siblingId, "sibling-of", 0.25);
          if (sibling) {
            extra.push(sibling);
            nextFrontier.push(sibling);
            seen.add(sibling.docId);
          }
        }
      }
      for (const mention of findMentionNeighbors(dataset, item, seen, depth === 1 ? 4 : 2)) {
        if (!mention || seen.has(mention.docId)) continue;
        extra.push(mention);
        nextFrontier.push(mention);
        seen.add(mention.docId);
      }
    }
    if (nextFrontier.length === 0) break;
    frontier = nextFrontier
      .sort((a, b) => (b.surveyScore || 0) - (a.surveyScore || 0))
      .slice(0, maxFrontier);
  }
  return extra;
}

function deriveFollowupQueries(candidates) {
  const queries = [];
  for (const item of candidates.slice(0, 8)) {
    if (item.title) queries.push(item.title);
    if (item.parentTitle) queries.push(item.parentTitle);
  }
  return uniq(queries.filter(Boolean)).slice(0, 10);
}

function clusterKeyForItem(item) {
  return item.parentRelPath || item.relPath;
}

function clusterLabelForItem(item) {
  return item.parentTitle || item.title;
}

function buildStructuralClusters(candidates) {
  const groups = new Map();
  for (const item of candidates) {
    const key = clusterKeyForItem(item);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: clusterLabelForItem(item),
        docs: [],
      });
    }
    groups.get(key).docs.push(item);
  }
  return [...groups.values()]
    .map((cluster) => ({
      ...cluster,
      docs: cluster.docs.sort((a, b) => {
        const seedDiff = seedPriority(b) - seedPriority(a);
        if (seedDiff !== 0) return seedDiff;
        const structuralDiff = structuralPriority(b) - structuralPriority(a);
        if (structuralDiff !== 0) return structuralDiff;
        return b.surveyScore - a.surveyScore;
      }),
      score: Math.max(...cluster.docs.map((item) => item.surveyScore || 0)),
    }))
    .sort((a, b) => b.score - a.score);
}

function surveyResearch({ docsRoot, catalogEntries, plan, topK = 6 }) {
  const seen = new Map();
  const runs = [];
  const targets = resolveTargets({ docsRoot, catalogEntries }, plan.versions, plan.languages);
  function runQueries(queries, phase) {
    for (const query of queries) {
      const datasetRuns = targets.map((meta) => scoreDataset(loadDataset(meta), query, { topK }));
      const result = {
        results: datasetRuns.flatMap((entry) => entry.results),
      };
      runs.push({
        phase,
        query,
        resultCount: result.results.length,
        topTitles: result.results.slice(0, 5).map((item) => item.title),
      });
      for (const entry of datasetRuns) {
        for (const item of entry.results) {
          addSurveyCandidate(seen, item, {
            matchedQueries: [query],
            scoreDelta: item.score,
            structureReasons: ["search-hit"],
          });
        }
        const structuralAdds = expandStructuralNeighborhood(entry.dataset, entry.results);
        for (const item of structuralAdds) {
          addSurveyCandidate(seen, item, {
            matchedQueries: item.matchedQueries,
            scoreDelta: item.surveyScore,
            structureReasons: item.structureReasons,
          });
        }
      }
    }
  }

  runQueries(plan.queries, "seed");

  const seedCandidates = [...seen.values()]
    .sort((a, b) => b.surveyScore - a.surveyScore)
    .slice(0, 12);
  const followupQueries = deriveFollowupQueries(seedCandidates).filter((query) => !plan.queries.includes(query));
  runQueries(followupQueries, "lineage");

  const candidates = [...seen.values()]
    .sort((a, b) => {
      const seedDiff = seedPriority(b) - seedPriority(a);
      if (seedDiff !== 0) return seedDiff;
      if (b.surveyScore !== a.surveyScore) return b.surveyScore - a.surveyScore;
      return a.title.localeCompare(b.title);
    })
    .slice(0, 48);
  const clusters = buildStructuralClusters(candidates);
  return { runs, candidates, clusters };
}

function pickRepresentativeDocs(plan, survey) {
  const selected = [];
  const selectedKeys = new Set();
  const maxSelected = plan.facets.includes("version_diff") ? 14 : 10;

  function take(predicate, count = 1) {
    for (const item of survey.candidates) {
      const key = `${item.folderName}/${item.relPath}`;
      if (selectedKeys.has(key)) continue;
      if (!predicate(item)) continue;
      selected.push(item);
      selectedKeys.add(key);
      if (count <= 1) return;
      count -= 1;
    }
  }

  for (const cluster of survey.clusters.slice(0, 5)) {
    const docs = cluster.docs;
    take((item) => clusterKeyForItem(item) === cluster.key && seedPriority(item) >= 3, 2);
    if (plan.facets.includes("version_diff") && (plan.versions || []).length >= 2) {
      for (const version of plan.versions) {
        take((item) => clusterKeyForItem(item) === cluster.key && item.version === version, 1);
      }
    }
    take((item) => clusterKeyForItem(item) === cluster.key && seedPriority(item) === 2, 1);
    take((item) => clusterKeyForItem(item) === cluster.key && !item.parentRelPath, 1);
    take((item) => clusterKeyForItem(item) === cluster.key && item.docTypes.includes("workflow"), 1);
    take((item) => clusterKeyForItem(item) === cluster.key && item.docTypes.includes("reference"), 1);
    take((item) => clusterKeyForItem(item) === cluster.key && item.docTypes.includes("material"), 1);
    if (selected.length >= maxSelected) break;
    if (docs.length > 0) take((item) => clusterKeyForItem(item) === cluster.key, Math.min(2, docs.length));
  }

  if (plan.facets.includes("setup")) take((item) => item.docTypes.includes("workflow"), 2);
  if (plan.facets.includes("requirements")) take((item) => item.docTypes.includes("reference"), 2);
  if (plan.facets.includes("limitations")) take((item) => item.docTypes.includes("reference") || item.docTypes.includes("solver"), 2);

  const minTarget = Math.min(plan.facets.includes("version_diff") ? 10 : 8, survey.candidates.length);
  if (selected.length < minTarget) {
    take(() => true, minTarget - selected.length);
  }

  return selected.slice(0, maxSelected).map((item) => ({
    ...item,
    clusterKey: clusterKeyForItem(item),
    clusterLabel: clusterLabelForItem(item),
  }));
}

function pickKeySentences(text, patterns, limit = 2) {
  const sentences = String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hits = [];
  for (const line of sentences) {
    if (patterns.some((pattern) => pattern.test(line))) {
      hits.push(line);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

function extractEvidenceFromDoc(doc) {
  const text = String(doc.text || "");
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const definition = lines.slice(0, 3).join(" ");
  const setup = pickKeySentences(text, [/节点路径示例/, /提供方式/, /工作流/, /辐射通量选项/, /光谱波段/, /坐标集合/], 4);
  const requirements = pickKeySentences(text, [/^要求$/, /^- 空间/, /^- 时间/, /^- 可选模型/, /需要/, /要求/], 6);
  const limitations = pickKeySentences(
    text,
    [/不兼容/, /权衡/, /代价/, /显著增加/, /必须/, /只能/, /默认值/, /限制/],
    6,
  );
  const selection = pickKeySentences(
    text,
    [/用于模拟/, /适用于/, /如果要/, /选择/, /波长 无关/, /波长 有关/, /非参与介质/, /可吸收、发射或散射/],
    6,
  );
  return {
    definition,
    setup,
    requirements,
    limitations,
    selection,
  };
}

function readResearchDocs({ docsRoot, catalogEntries, selectedDocs, question }) {
  return selectedDocs.map((item) => {
    const doc = readDocument({
      docsRoot,
      catalogEntries,
      folderName: item.folderName,
      relPath: item.relPath,
      query: question,
      maxChars: 12000,
    });
    const evidence = extractEvidenceFromDoc(doc);
    return {
      ...item,
      read: {
        title: doc.title,
        folderName: doc.folderName,
        relPath: doc.relPath,
        extractionMethod: doc.extractionMethod,
        textLength: doc.textLength,
        excerpt: doc.excerpt,
        evidence,
      },
    };
  });
}

function buildResearchComparisons({ docsRoot, catalogEntries, plan, queries, topK = 6 }) {
  if (!plan.facets.includes("version_diff") || (plan.versions || []).length < 2) return [];
  const [baseVersion, targetVersion] = plan.versions;
  const compareQueries = uniq([
    ...(queries || []).slice(0, 4),
    ...(plan.topics || []).slice(0, 2),
  ].filter(Boolean)).slice(0, 5);
  return compareQueries.map((query) => compareVersions({
    docsRoot,
    catalogEntries,
    query,
    baseVersion,
    targetVersion,
    languages: plan.languages,
    topK: Math.min(Math.max(Number(topK || 6), 4), 8),
  }));
}

function clusterMatchesPair(clusterDocs, pair) {
  const clusterTerms = new Set();
  for (const item of clusterDocs) {
    for (const term of buildTitleTerms(item.clusterLabel || item.title || "")) clusterTerms.add(term);
    for (const term of buildTitleTerms(item.title || "")) clusterTerms.add(term);
  }
  const pairTerms = new Set([
    ...buildTitleTerms(pair.base?.title || ""),
    ...buildTitleTerms(pair.target?.title || ""),
  ]);
  let overlap = 0;
  for (const term of clusterTerms) {
    if (pairTerms.has(term)) overlap += 1;
  }
  return overlap >= 1;
}

function buildCoverage(plan, readDocs, compareRuns = []) {
  const coverage = {};
  const clusterKeys = uniq(readDocs.map((item) => item.clusterKey));
  for (const clusterKey of clusterKeys) {
    const clusterDocs = readDocs.filter((item) => item.clusterKey === clusterKey);
    const label = clusterDocs[0]?.clusterLabel || clusterKey;
    coverage[clusterKey] = { label };
    for (const facet of plan.facets) {
      let ok = false;
      if (facet === "definition") ok = clusterDocs.some((doc) => doc.read.evidence.definition);
      if (facet === "classification") ok = clusterDocs.length >= 2 || clusterDocs.some((doc) => /(模型|工作流|参考|workflow|reference)/i.test(doc.title));
      if (facet === "selection") ok = clusterDocs.some((doc) => doc.read.evidence.selection.length > 0);
      if (facet === "setup") ok = clusterDocs.some((doc) => doc.read.evidence.setup.length > 0 || doc.docTypes.includes("workflow"));
      if (facet === "requirements") ok = clusterDocs.some((doc) => doc.read.evidence.requirements.length > 0);
      if (facet === "limitations") ok = clusterDocs.some((doc) => doc.read.evidence.limitations.length > 0);
      if (facet === "version_diff") {
        const versionsSeen = uniq(clusterDocs.map((doc) => doc.version).filter(Boolean));
        const compareHit = compareRuns.some((run) => (run.pairedComparisons || []).some((pair) => clusterMatchesPair(clusterDocs, pair)));
        ok = versionsSeen.length >= 2 || compareHit;
      }
      coverage[clusterKey][facet] = ok ? "covered" : "missing";
    }
  }
  return coverage;
}

function buildResearchGaps(plan, coverage) {
  const nextQueries = [];
  const gaps = [];
  for (const [clusterKey, facets] of Object.entries(coverage)) {
    const label = facets.label || clusterKey;
    for (const facet of plan.facets) {
      if (facets[facet] !== "missing") continue;
      gaps.push(`${label}:${facet}`);
      nextQueries.push(label);
      if (facet === "setup") {
        nextQueries.push(`${label} 工作流`);
        nextQueries.push(`${label} workflow`);
      }
      if (facet === "requirements" || facet === "limitations") {
        nextQueries.push(`${label} 参考`);
        nextQueries.push(`${label} reference`);
      }
      if (facet === "version_diff") {
        nextQueries.push(`${label} 18.04 20.06`);
        nextQueries.push(`${label} compare`);
      }
    }
  }
  return {
    gaps,
    nextQueries: uniq(nextQueries.filter(Boolean)).slice(0, 8),
    done: gaps.length === 0,
  };
}

function buildEvidenceBundles(plan, readDocs) {
  const clusterKeys = uniq(readDocs.map((item) => item.clusterKey));
  return clusterKeys.map((clusterKey) => {
    const clusterDocs = readDocs.filter((item) => item.clusterKey === clusterKey);
    return {
      clusterKey,
      label: clusterDocs[0]?.clusterLabel || clusterKey,
      docs: clusterDocs.map((item) => ({
        title: item.title,
        folderName: item.folderName,
        relPath: item.relPath,
        docTypes: item.docTypes,
        structureReasons: item.structureReasons,
        evidence: item.read.evidence,
      })),
    };
  });
}

function formatResearchMarkdown(result) {
  const lines = [];
  lines.push(`Question: ${result.plan.question}`);
  lines.push(`Planner: ${result.plan.planner?.source || "heuristic-fallback"}`);
  if (result.plan.planner?.focus) lines.push(`Focus: ${result.plan.planner.focus}`);
  lines.push(`Facets: ${result.plan.facets.join(", ") || "(none)"}`);
  lines.push("");
  lines.push("Research Plan:");
  if ((result.plan.zhQueries || []).length > 0) {
    lines.push("ZH prompts:");
    result.plan.zhQueries.forEach((query, index) => lines.push(`${index + 1}. ${query}`));
  }
  if ((result.plan.enQueries || []).length > 0) {
    lines.push("EN prompts:");
    result.plan.enQueries.forEach((query, index) => lines.push(`${index + 1}. ${query}`));
  }
  if ((result.plan.zhQueries || []).length === 0 && (result.plan.enQueries || []).length === 0) {
    result.plan.queries.forEach((query, index) => lines.push(`${index + 1}. ${query}`));
  }
  lines.push("");
  lines.push(`Surveyed queries: ${result.survey.runs.length}`);
  lines.push(`Selected docs: ${result.selectedDocs.length}`);
  if ((result.rounds || []).length > 0) {
    lines.push(`Research rounds: ${result.rounds.length}`);
    result.rounds.forEach((round) => {
      lines.push(`- round ${round.round}: queries=${round.queryCount}, selected=${round.selectedDocCount}, gaps=${round.gapCount}`);
    });
  }
  result.selectedDocs.forEach((item, index) => {
    lines.push(`${index + 1}. [${item.language}_${item.version}] ${item.title}`);
    lines.push(`   path: ${item.folderName}/${item.relPath}`);
    lines.push(`   types: ${item.docTypes.join(", ") || "topic"}`);
    lines.push(`   cluster: ${item.clusterLabel || item.clusterKey}`);
  });
  lines.push("");
  lines.push("Coverage:");
  for (const [clusterKey, facets] of Object.entries(result.coverage)) {
    const pairs = Object.entries(facets)
      .filter(([facet]) => facet !== "label")
      .map(([facet, status]) => `${facet}=${status}`);
    lines.push(`- ${facets.label || clusterKey}: ${pairs.join(", ")}`);
  }
  lines.push("");
  if (result.gaps.done) {
    lines.push("Coverage status: sufficient for summary.");
  } else {
    lines.push(`Coverage status: incomplete.`);
    lines.push(`Open gaps: ${result.gaps.gaps.join("; ")}`);
    if (result.gaps.nextQueries.length > 0) {
      lines.push(`Suggested next queries: ${result.gaps.nextQueries.join(" | ")}`);
    }
  }
  if ((result.compareRuns || []).length > 0) {
    lines.push("");
    lines.push("Version comparisons:");
    result.compareRuns.slice(0, 3).forEach((run) => {
      lines.push(`- ${run.query}: paired=${run.pairedComparisons?.length || 0}, common=${run.commonTitles?.length || 0}`);
    });
  }
  lines.push("");
  lines.push("Evidence Bundles:");
  for (const bundle of result.evidenceBundles) {
    if (bundle.docs.length === 0) continue;
    lines.push(`- ${bundle.label}`);
    for (const doc of bundle.docs.slice(0, 3)) {
      lines.push(`  ${doc.title} :: ${doc.folderName}/${doc.relPath}`);
      if (doc.evidence.definition) lines.push(`  def: ${doc.evidence.definition.slice(0, 180)}`);
      if (doc.evidence.selection[0]) lines.push(`  sel: ${doc.evidence.selection[0].slice(0, 180)}`);
    }
  }
  return lines.join("\n");
}

async function runResearchSession({ api, docsRoot, catalogEntries, question, versions = [], languages = ["zh", "en"], topK = 6 }) {
  const plannerOutput = await generatePlannerOutput({ api, question, versions, languages });
  let plan = createResearchPlan({ question, versions, languages, plannerOutput });
  const rounds = [];
  let survey = { runs: [], candidates: [], clusters: [] };
  let selectedDocs = [];
  let readDocs = [];
  let compareRuns = [];
  let coverage = {};
  let gaps = { gaps: [], nextQueries: [], done: false };
  let evidenceBundles = [];

  for (let round = 1; round <= 3; round += 1) {
    survey = surveyResearch({ docsRoot, catalogEntries, plan, topK });
    selectedDocs = pickRepresentativeDocs(plan, survey);
    readDocs = readResearchDocs({ docsRoot, catalogEntries, selectedDocs, question });
    compareRuns = buildResearchComparisons({ docsRoot, catalogEntries, plan, queries: plan.queries, topK });
    coverage = buildCoverage(plan, readDocs, compareRuns);
    gaps = buildResearchGaps(plan, coverage);
    evidenceBundles = buildEvidenceBundles(plan, readDocs);
    rounds.push({
      round,
      queryCount: plan.queries.length,
      selectedDocCount: selectedDocs.length,
      gapCount: gaps.gaps.length,
      nextQueries: gaps.nextQueries,
    });
    if (gaps.done) break;
    const newQueries = gaps.nextQueries.filter((query) => !(plan.queries || []).includes(query));
    if (newQueries.length === 0) break;
    plan = appendPlanQueries(plan, newQueries);
  }

  return {
    plan,
    rounds,
    survey,
    selectedDocs,
    readDocs,
    compareRuns,
    coverage,
    gaps,
    evidenceBundles,
  };
}

function parsePostingString(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [docIdRaw, scoreRaw, positionsRaw = ""] = entry.split("*");
      const hitCount = positionsRaw ? positionsRaw.split("$").filter(Boolean).length : 0;
      return {
        docId: Number(docIdRaw),
        weight: Number(scoreRaw || 0),
        hitCount,
      };
    })
    .filter((entry) => Number.isFinite(entry.docId));
}

function loadDataset(meta) {
  if (datasetCache.has(meta.key)) return datasetCache.get(meta.key);

  const indexDir = path.join(meta.dir, "oxygen-webhelp", "app", "search", "index");
  const htmlFileInfoList = evaluateVarFile(path.join(indexDir, "htmlFileInfoList.js"), ["htmlFileInfoList"]);
  const stopwords = evaluateVarFile(path.join(indexDir, "stopwords.js"), ["stopwords", "stopWords"]);
  const linkToParent = evaluateVarFile(path.join(indexDir, "link-to-parent.js"), ["linkToParent", "link2parent"]);
  const index1 = evaluateVarFile(path.join(indexDir, "index-1.js"), ["index1"]);
  const index2 = evaluateVarFile(path.join(indexDir, "index-2.js"), ["index2"]);
  const index3 = evaluateVarFile(path.join(indexDir, "index-3.js"), ["index3"]);

  const docs = htmlFileInfoList.map((raw, index) => parseTopicInfo(raw, index, meta.dir));
  const postings = new Map();
  const lexicon = [];
  const titleTokenIndex = new Map();

  for (const part of [index1, index2, index3]) {
    for (const [word, rawPosting] of Object.entries(part)) {
      const key = String(word).toLowerCase();
      if (!postings.has(key)) {
        postings.set(key, []);
        lexicon.push(key);
      }
      postings.get(key).push(...parsePostingString(rawPosting));
    }
  }

  for (const doc of docs) {
    const parentIdRaw = linkToParent?.[doc.id];
    const parentId = Number.isFinite(Number(parentIdRaw)) ? Number(parentIdRaw) : null;
    if (parentId !== null && parentId >= 0 && docs[parentId]) {
      doc.parentId = parentId;
      doc.parentRelPath = docs[parentId].relPath;
      doc.parentTitle = docs[parentId].title;
    } else {
      doc.parentId = null;
      doc.parentRelPath = "";
      doc.parentTitle = "";
    }
    doc.childIds = [];
  }

  for (const doc of docs) {
    if (doc.parentId !== null && docs[doc.parentId]) {
      docs[doc.parentId].childIds.push(doc.id);
    }
    for (const token of buildTitleTerms(doc.title || "")) {
      if (!titleTokenIndex.has(token)) titleTokenIndex.set(token, []);
      titleTokenIndex.get(token).push(doc.id);
    }
  }

  const dataset = {
    ...meta,
    docs,
    postings,
    lexicon,
    titleTokenIndex,
    stopwords: new Set((stopwords || []).map((item) => String(item).toLowerCase())),
    linkToParent: linkToParent || {},
  };
  datasetCache.set(meta.key, dataset);
  return dataset;
}

function scoreDataset(dataset, query, options = {}) {
  const topK = Math.min(Math.max(Number(options.topK || 6), 1), MAX_RESULTS);
  const includeExcerpt = options.includeExcerpt !== false;
  const queryText = String(query || "").trim();
  if (!queryText) {
    return {
      dataset,
      query: queryText,
      results: [],
      tokens: [],
    };
  }

  const tokens = tokenizeQuery(queryText).filter((token) => !dataset.stopwords.has(token));
  const scored = new Map();

  function touch(docId) {
    if (!scored.has(docId)) {
      scored.set(docId, {
        score: 0,
        matchedTokens: new Set(),
        reasons: [],
      });
    }
    return scored.get(docId);
  }

  for (const token of tokens) {
    const exactMatches = dataset.postings.get(token) || [];
    for (const match of exactMatches) {
      const row = touch(match.docId);
      row.score += 36 + match.weight * 10 + match.hitCount * 2;
      row.matchedTokens.add(token);
      row.reasons.push(`index:${token}`);
    }

    if (exactMatches.length === 0 && token.length >= 3) {
      const prefixCandidates = [];
      for (const word of dataset.lexicon) {
        if (!word.startsWith(token)) continue;
        prefixCandidates.push(word);
        if (prefixCandidates.length >= 12) break;
      }
      for (const word of prefixCandidates) {
        for (const match of dataset.postings.get(word) || []) {
          const row = touch(match.docId);
          row.score += 10 + match.weight * 3;
          row.matchedTokens.add(token);
          row.reasons.push(`prefix:${word}`);
        }
      }
    }
  }

  const wholeQueryLower = queryText.toLowerCase();
  for (const doc of dataset.docs) {
    const haystack = `${doc.title}\n${doc.description}\n${doc.relPath}`.toLowerCase();
    let score = 0;
    if (wholeQueryLower && haystack.includes(wholeQueryLower)) score += 80;
    for (const token of tokens) {
      if (haystack.includes(token)) {
        score += 12;
        touch(doc.id).matchedTokens.add(token);
      }
      if (doc.title.toLowerCase().includes(token)) {
        score += 18;
        touch(doc.id).matchedTokens.add(token);
      }
      if (doc.description.toLowerCase().includes(token)) {
        score += 8;
        touch(doc.id).matchedTokens.add(token);
      }
    }
    if (score > 0) {
      const row = touch(doc.id);
      row.score += score;
      row.reasons.push("text");
    }
  }

  const results = [...scored.entries()]
    .map(([docId, info]) => {
      const doc = dataset.docs[docId];
      return {
        docId: doc.id,
        version: dataset.version,
        language: dataset.language,
        folderName: dataset.folderName,
        title: doc.title,
        description: doc.description,
        relPath: doc.relPath,
        absolutePath: doc.absolutePath,
        parentId: doc.parentId,
        parentRelPath: doc.parentRelPath,
        parentTitle: doc.parentTitle,
        childIds: doc.childIds,
        score: info.score,
        matchedTokens: [...info.matchedTokens],
        reasons: uniq(info.reasons),
      };
    })
    .filter((item) => item.title)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.title.localeCompare(b.title);
    })
    .slice(0, topK)
    .map((item) => ({
      ...item,
      excerpt: includeExcerpt ? readExcerpt(item.absolutePath, queryText, tokens) : "",
    }));

  return {
    dataset,
    query: queryText,
    tokens,
    results,
  };
}

function searchAcrossDatasets({
  docsRoot,
  catalogEntries,
  query,
  versions,
  languages,
  topK,
  includeStructural = true,
  includeExcerpt = true,
}) {
  const targets = resolveTargets({ docsRoot, catalogEntries }, versions, languages);
  const datasetResults = targets.map((meta) => {
    const dataset = loadDataset(meta);
    const base = scoreDataset(dataset, query, { topK, includeExcerpt });
    const expanded = includeStructural
      ? expandStructuralNeighborhood(
        dataset,
        base.results.map((item) => ({
          ...item,
          surveyScore: item.score,
          matchedQueries: [query],
          structureReasons: ["search-hit"],
        })),
        { maxDepth: 3, maxFrontier: Math.max(Number(topK || 6), 6) },
      )
      : [];
    const expandedResults = expanded.map((item) => ({
      ...item,
      score: item.surveyScore || item.score || 0,
      excerpt: includeExcerpt ? readExcerpt(item.absolutePath, query, tokenizeQuery(query)) : "",
    }));
    const results = [...base.results, ...expandedResults]
      .sort((a, b) => {
        if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
        return a.title.localeCompare(b.title);
      })
      .filter((item, index, arr) => arr.findIndex((x) => x.relPath === item.relPath && x.folderName === item.folderName) === index)
      .slice(0, Math.min(Math.max(Number(topK || 6), 1), MAX_RESULTS));
    return {
      ...base,
      results,
    };
  });
  const combined = datasetResults
    .flatMap((entry) => entry.results)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.version !== b.version) return b.version.localeCompare(a.version);
      return a.title.localeCompare(b.title);
    })
    .slice(0, Math.min(Math.max(Number(topK || 6), 1), MAX_RESULTS));

  return {
    docsRoot,
    query,
    versions: uniq((versions || []).map(normalizeVersion)),
    languages: uniq((languages || []).map(normalizeLanguage)),
    searched: targets.map((item) => ({
      version: item.version,
      language: item.language,
      folderName: item.folderName,
    })),
    grouped: datasetResults.map((entry) => ({
      version: entry.dataset.version,
      language: entry.dataset.language,
      folderName: entry.dataset.folderName,
      tokens: entry.tokens,
      results: entry.results,
    })),
    results: combined,
  };
}

function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

function buildCompareTextPreview(text, maxLen = 360) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 3).trim()}...`;
}

function extractCompareTerms(text, query = "") {
  const sample = String(text || "").slice(0, 5000);
  if (!sample.trim()) return [];
  const queryTokens = new Set(tokenizeQuery(query));
  const counts = new Map();

  const wordMatches = sample.match(/[\p{L}\p{N}_.+:-]{3,}/gu) || [];
  for (const word of wordMatches) {
    const normalized = word.toLowerCase();
    if (RESEARCH_STOP_TERMS.has(normalized) || queryTokens.has(normalized)) continue;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }

  const cjkMatches = sample.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,12}/gu) || [];
  for (const chunk of cjkMatches) {
    const normalized = chunk.toLowerCase();
    if (RESEARCH_STOP_TERMS.has(normalized) || queryTokens.has(normalized)) continue;
    counts.set(normalized, (counts.get(normalized) || 0) + 2);
  }

  return [...counts.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, 12)
    .map(([term]) => term);
}

function buildDocCompareProfile({ docsRoot, catalogEntries, doc, query }) {
  const read = readDocument({
    docsRoot,
    catalogEntries,
    relPath: doc.relPath,
    folderName: doc.folderName,
    query,
    maxChars: 6000,
  });
  const preview = buildCompareTextPreview(read.excerpt || read.text, 360);
  const lead = buildCompareTextPreview(read.text, 220);
  const terms = extractCompareTerms(read.text, query);
  return {
    title: doc.title,
    version: doc.version,
    language: doc.language,
    folderName: doc.folderName,
    relPath: doc.relPath,
    score: doc.score,
    excerpt: preview,
    lead,
    terms,
  };
}

function buildTitleTerms(title) {
  return new Set(tokenizeQuery(title).filter((token) => token.length >= 2));
}

function scoreTitleMatch(baseDoc, targetDoc) {
  const baseNorm = normalizeTitle(baseDoc.title);
  const targetNorm = normalizeTitle(targetDoc.title);
  if (!baseNorm || !targetNorm) return -1;

  let score = 0;
  if (baseNorm === targetNorm) score += 200;
  if (baseDoc.language === targetDoc.language) score += 25;
  if (path.basename(baseDoc.relPath) === path.basename(targetDoc.relPath)) score += 40;

  const baseTerms = buildTitleTerms(baseDoc.title);
  const targetTerms = buildTitleTerms(targetDoc.title);
  let overlap = 0;
  for (const term of baseTerms) {
    if (targetTerms.has(term)) overlap += 1;
  }
  if (overlap > 0) score += overlap * 18;

  const denom = Math.max(baseTerms.size, targetTerms.size, 1);
  const overlapRatio = overlap / denom;
  if (overlapRatio >= 0.6) score += 40;
  else if (overlapRatio >= 0.4) score += 20;

  if (baseNorm.includes(targetNorm) || targetNorm.includes(baseNorm)) score += 24;
  score += ((targetDoc.score || 0) / 1000);
  return score;
}

function chooseBestTargetMatch(baseDoc, candidates, usedTargetKeys = new Set()) {
  let best = null;
  let bestScore = -1;
  for (const item of candidates) {
    const targetKey = `${item.language}:${item.relPath}`;
    if (usedTargetKeys.has(targetKey)) continue;
    const score = scoreTitleMatch(baseDoc, item);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  if (bestScore < 36) return null;
  return best;
}

function buildPairedComparisons({ docsRoot, catalogEntries, query, baseResults, targetResults }) {
  const seenPairs = new Set();
  const usedTargetKeys = new Set();
  const pairs = [];
  for (const baseDoc of baseResults) {
    const key = normalizeTitle(baseDoc.title);
    const targetDoc = chooseBestTargetMatch(baseDoc, targetResults, usedTargetKeys);
    if (!targetDoc) continue;
    const pairKey = `${baseDoc.language}:${baseDoc.relPath}=>${targetDoc.language}:${targetDoc.relPath}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    usedTargetKeys.add(`${targetDoc.language}:${targetDoc.relPath}`);

    const baseProfile = buildDocCompareProfile({ docsRoot, catalogEntries, doc: baseDoc, query });
    const targetProfile = buildDocCompareProfile({ docsRoot, catalogEntries, doc: targetDoc, query });
    const sharedTerms = baseProfile.terms.filter((term) => targetProfile.terms.includes(term)).slice(0, 6);
    const baseOnlyTerms = baseProfile.terms.filter((term) => !targetProfile.terms.includes(term)).slice(0, 6);
    const targetOnlyTerms = targetProfile.terms.filter((term) => !baseProfile.terms.includes(term)).slice(0, 6);
    const titleMatchScore = scoreTitleMatch(baseDoc, targetDoc);

    pairs.push({
      normalizedTitle: key,
      sameLanguage: baseDoc.language === targetDoc.language,
      sameBasename: path.basename(baseDoc.relPath) === path.basename(targetDoc.relPath),
      exactTitleMatch: normalizeTitle(baseDoc.title) === normalizeTitle(targetDoc.title),
      titleMatchScore,
      base: baseProfile,
      target: targetProfile,
      sharedTerms,
      baseOnlyTerms,
      targetOnlyTerms,
    });
  }

  return pairs
    .sort((a, b) => {
      const aScore = (a.base.score || 0) + (a.target.score || 0);
      const bScore = (b.base.score || 0) + (b.target.score || 0);
      if (bScore !== aScore) return bScore - aScore;
      return a.base.title.localeCompare(b.base.title);
    })
    .slice(0, 6);
}

function compareVersions({ docsRoot, catalogEntries, query, baseVersion, targetVersion, languages, topK }) {
  const base = searchAcrossDatasets({
    docsRoot,
    catalogEntries,
    query,
    versions: [baseVersion],
    languages,
    topK,
  });
  const target = searchAcrossDatasets({
    docsRoot,
    catalogEntries,
    query,
    versions: [targetVersion],
    languages,
    topK,
  });

  const baseTitles = new Set(base.results.map((item) => normalizeTitle(item.title)).filter(Boolean));
  const targetTitles = new Set(target.results.map((item) => normalizeTitle(item.title)).filter(Boolean));

  const commonTitles = [];
  for (const item of base.results) {
    const normalized = normalizeTitle(item.title);
    if (targetTitles.has(normalized) && !commonTitles.includes(item.title)) {
      commonTitles.push(item.title);
    }
  }

  const baseOnly = base.results.filter((item) => !targetTitles.has(normalizeTitle(item.title)));
  const targetOnly = target.results.filter((item) => !baseTitles.has(normalizeTitle(item.title)));
  const pairedComparisons = buildPairedComparisons({
    docsRoot,
    catalogEntries,
    query,
    baseResults: base.results,
    targetResults: target.results,
  });

  return {
    query,
    baseVersion: normalizeVersion(baseVersion),
    targetVersion: normalizeVersion(targetVersion),
    languages: uniq((languages || []).map(normalizeLanguage)),
    base,
    target,
    commonTitles,
    baseOnly,
    targetOnly,
    pairedComparisons,
  };
}

function formatSearchMarkdown(result) {
  const lines = [];
  lines.push(`Query: ${result.query}`);
  lines.push(
    `Searched datasets: ${
      result.searched.map((item) => `${item.language}_${item.version}`).join(", ") || "(none)"
    }`,
  );
  if (result.results.length === 0) {
    lines.push("No matching documentation topics were found.");
    return lines.join("\n");
  }
  lines.push("");
  result.results.forEach((item, index) => {
    lines.push(
      `${index + 1}. [${item.language}_${item.version}] ${item.title}`,
    );
    lines.push(`   path: ${item.folderName}/${item.relPath}`);
    if (item.description) lines.push(`   summary: ${item.description}`);
    if (item.excerpt) lines.push(`   excerpt: ${item.excerpt}`);
    if (item.matchedTokens.length > 0) lines.push(`   matched: ${item.matchedTokens.join(", ")}`);
    if ((item.structureReasons || []).length > 0) lines.push(`   structure: ${item.structureReasons.join(", ")}`);
  });
  return lines.join("\n");
}

function formatCompareMarkdown(result) {
  const lines = [];
  lines.push(`Query: ${result.query}`);
  lines.push(`Compare: ${result.baseVersion} vs ${result.targetVersion}`);
  lines.push(`Languages: ${result.languages.join(", ") || "zh, en"}`);
  lines.push("");

  lines.push(`Common topics (${result.commonTitles.length}):`);
  if (result.commonTitles.length === 0) {
    lines.push("- none in the top results");
  } else {
    for (const title of result.commonTitles.slice(0, 8)) lines.push(`- ${title}`);
  }

  lines.push("");
  lines.push(`Top hits in ${result.baseVersion}:`);
  if (result.base.results.length === 0) {
    lines.push("- none");
  } else {
    result.base.results.slice(0, 5).forEach((item) => {
      lines.push(`- [${item.language}_${item.version}] ${item.title} :: ${item.folderName}/${item.relPath}`);
    });
  }

  lines.push("");
  lines.push(`Top hits in ${result.targetVersion}:`);
  if (result.target.results.length === 0) {
    lines.push("- none");
  } else {
    result.target.results.slice(0, 5).forEach((item) => {
      lines.push(`- [${item.language}_${item.version}] ${item.title} :: ${item.folderName}/${item.relPath}`);
    });
  }

  if (result.baseOnly.length > 0) {
    lines.push("");
    lines.push(`Only prominent in ${result.baseVersion}:`);
    result.baseOnly.slice(0, 5).forEach((item) => {
      lines.push(`- ${item.title} :: ${item.folderName}/${item.relPath}`);
    });
  }

  if (result.targetOnly.length > 0) {
    lines.push("");
    lines.push(`Only prominent in ${result.targetVersion}:`);
    result.targetOnly.slice(0, 5).forEach((item) => {
      lines.push(`- ${item.title} :: ${item.folderName}/${item.relPath}`);
    });
  }

  if (result.pairedComparisons?.length > 0) {
    lines.push("");
    lines.push("Paired page comparisons:");
    result.pairedComparisons.slice(0, 4).forEach((pair, index) => {
      lines.push(`${index + 1}. ${pair.base.title}`);
      lines.push(`   base: [${pair.base.language}_${pair.base.version}] ${pair.base.folderName}/${pair.base.relPath}`);
      lines.push(`   target: [${pair.target.language}_${pair.target.version}] ${pair.target.folderName}/${pair.target.relPath}`);
      lines.push(`   title match: ${pair.exactTitleMatch ? "exact" : "approx"} (${pair.titleMatchScore.toFixed(1)})`);
      if (pair.sharedTerms.length > 0) lines.push(`   shared terms: ${pair.sharedTerms.join(", ")}`);
      if (pair.baseOnlyTerms.length > 0) lines.push(`   base-emphasis: ${pair.baseOnlyTerms.join(", ")}`);
      if (pair.targetOnlyTerms.length > 0) lines.push(`   target-emphasis: ${pair.targetOnlyTerms.join(", ")}`);
      if (pair.base.excerpt) lines.push(`   base excerpt: ${pair.base.excerpt}`);
      if (pair.target.excerpt) lines.push(`   target excerpt: ${pair.target.excerpt}`);
    });
  }

  return lines.join("\n");
}

function buildSearchTool(api) {
  return {
    name: "starccm_doc_search",
    label: "STAR-CCM+ Doc Search",
    description:
      "Search local STAR-CCM+ documentation across zh/en and multiple versions using the offline Oxygen WebHelp index. " +
      "Use this before answering STAR-CCM+ factual questions.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Question, keyword, or feature name to search." },
        versions: {
          type: "array",
          items: { type: "string" },
          description: "Optional version filter, for example ['18.04'] or ['18.04', '20.06'].",
        },
        languages: {
          type: "array",
          items: { type: "string" },
          description: "Optional language filter: zh and/or en.",
        },
        topK: {
          type: "number",
          description: "Maximum number of results to return. Default 6, max 12.",
        },
      },
      required: ["query"],
    },
    async execute(_toolCallId, params) {
      try {
        const { query, versions = [], languages = [], topK = 6 } = params || {};
        const result = searchAcrossDatasets({
          docsRoot: api.pluginConfig?.docsRoot,
          catalogEntries: api.pluginConfig?.datasets,
          query,
          versions,
          languages,
          topK,
        });
        return {
          content: [{ type: "text", text: formatSearchMarkdown(result) }],
          details: result,
          result,
          isError: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        api.logger.warn?.(`[starccm-docs] search failed: ${message}`);
        return {
          content: [{ type: "text", text: `starccm_doc_search failed: ${message}` }],
          details: { ok: false, error: message },
          result: { ok: false, error: message },
          isError: true,
        };
      }
    },
  };
}

function buildCompareTool(api) {
  return {
    name: "starccm_doc_compare",
    label: "STAR-CCM+ Doc Compare",
    description:
      "Compare STAR-CCM+ documentation between two versions, for example 18.04 vs 20.06. " +
      "This first aligns search results by title similarity, then reads paired pages to surface excerpt- and term-level differences. " +
      "Use this when the user asks what changed or wants version-specific guidance.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Question, keyword, workflow, or feature to compare." },
        baseVersion: { type: "string", description: "Base version, for example 18.04." },
        targetVersion: { type: "string", description: "Target version, for example 20.06." },
        languages: {
          type: "array",
          items: { type: "string" },
          description: "Optional language filter: zh and/or en.",
        },
        topK: {
          type: "number",
          description: "Maximum results per version. Default 6, max 12.",
        },
      },
      required: ["query", "baseVersion", "targetVersion"],
    },
    async execute(_toolCallId, params) {
      try {
        const { query, baseVersion, targetVersion, languages = ["zh", "en"], topK = 6 } = params || {};
        const result = compareVersions({
          docsRoot: api.pluginConfig?.docsRoot,
          catalogEntries: api.pluginConfig?.datasets,
          query,
          baseVersion,
          targetVersion,
          languages,
          topK,
        });
        return {
          content: [{ type: "text", text: formatCompareMarkdown(result) }],
          details: result,
          result,
          isError: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        api.logger.warn?.(`[starccm-docs] compare failed: ${message}`);
        return {
          content: [{ type: "text", text: `starccm_doc_compare failed: ${message}` }],
          details: { ok: false, error: message },
          result: { ok: false, error: message },
          isError: true,
        };
      }
    },
  };
}

function buildReadTool(api) {
  return {
    name: "starccm_doc_read",
    label: "STAR-CCM+ Doc Read",
    description:
      "Read and clean the body text of a STAR-CCM+ documentation page after search. " +
      "Use this on the top search hits before summarizing. If one page is insufficient, read more pages.",
    parameters: {
      type: "object",
      properties: {
        relPath: {
          type: "string",
          description: "Document relative path, for example GUID-59418EB9-4F39-43AE-A195-766C642E276D.html",
        },
        version: {
          type: "string",
          description: "Optional version like 20.06.",
        },
        language: {
          type: "string",
          description: "Optional language like zh or en.",
        },
        folderName: {
          type: "string",
          description: "Optional explicit dataset folder like zh_STARCCMP_20.06.",
        },
        query: {
          type: "string",
          description: "Optional original user question for excerpt targeting.",
        },
        maxChars: {
          type: "number",
          description: "Optional maximum returned body length. Default 12000.",
        },
      },
      required: ["relPath"],
    },
    async execute(_toolCallId, params) {
      try {
        const result = readDocument({
          docsRoot: api.pluginConfig?.docsRoot,
          catalogEntries: api.pluginConfig?.datasets,
          ...(params || {}),
        });
        const preview = [
          `Title: ${result.title}`,
          `Dataset: ${result.folderName}`,
          `Path: ${result.relPath}`,
          `Extraction: ${result.extractionMethod}`,
          result.description ? `Summary: ${result.description}` : "",
          result.excerpt ? `Excerpt: ${result.excerpt}` : "",
          "",
          result.text,
        ]
          .filter(Boolean)
          .join("\n");
        return {
          content: [{ type: "text", text: preview }],
          details: result,
          result,
          isError: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        api.logger.warn?.(`[starccm-docs] read failed: ${message}`);
        return {
          content: [{ type: "text", text: `starccm_doc_read failed: ${message}` }],
          details: { ok: false, error: message },
          result: { ok: false, error: message },
          isError: true,
        };
      }
    },
  };
}

function buildResearchTool(api) {
  return {
    name: "starccm_doc_research",
    label: "STAR-CCM+ Doc Research",
    description:
      "Run an explicit multi-step research workflow over local STAR-CCM+ docs: plan, survey, select, read, extract evidence, and check coverage. " +
      "Use this for non-trivial questions before writing the final answer.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The full user research question.",
        },
        versions: {
          type: "array",
          items: { type: "string" },
          description: "Optional version filter, for example ['20.06'] or ['18.04', '20.06'].",
        },
        languages: {
          type: "array",
          items: { type: "string" },
          description: "Optional language filter: zh and/or en. Default ['zh', 'en'].",
        },
        topK: {
          type: "number",
          description: "Maximum results per survey query. Default 6, max 12.",
        },
      },
      required: ["question"],
    },
    async execute(_toolCallId, params) {
      try {
        const { question, versions = [], languages = ["zh", "en"], topK = 6 } = params || {};
        const result = await runResearchSession({
          api,
          docsRoot: api.pluginConfig?.docsRoot,
          catalogEntries: api.pluginConfig?.datasets,
          question,
          versions,
          languages,
          topK,
        });
        return {
          content: [{ type: "text", text: formatResearchMarkdown(result) }],
          details: result,
          result,
          isError: false,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        api.logger.warn?.(`[starccm-docs] research failed: ${message}`);
        return {
          content: [{ type: "text", text: `starccm_doc_research failed: ${message}` }],
          details: { ok: false, error: message },
          result: { ok: false, error: message },
          isError: true,
        };
      }
    },
  };
}

function buildToolFactory(api) {
  return () => [buildSearchTool(api), buildReadTool(api), buildCompareTool(api), buildResearchTool(api)];
}

export {
  chooseNativeSearchMeta,
  loadNativeSearchMetaBundle,
  TOOL_NAMES,
  buildToolFactory,
  compareVersions,
  createResearchPlan,
  extractMainTextFromHtml,
  pluginConfigSchema,
  readDocument,
  runResearchSession,
  safeJson,
  scanCatalog,
  searchAcrossDatasets,
  tokenizeQueryList,
};

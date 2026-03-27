#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  chooseNativeSearchMeta,
  loadNativeSearchMetaBundle,
  readDocument,
  safeJson,
  scanCatalog,
  searchAcrossDatasets,
  tokenizeQueryList,
} from "./search-core.js";

const SUPPORTED_GRAPH_VERSIONS = new Set(["18.04", "20.06"]);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_CONFIG_PATH = path.join(SKILL_ROOT, "starccm-expert.json");

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    i += 1;
  }
  return { command, options };
}

function parseList(value, fallback = []) {
  if (!value) return fallback;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonList(value, fallback = []) {
  if (!value) return fallback;
  return JSON.parse(value);
}

function uniq(values) {
  return [...new Set(values)];
}

function loadSkillConfig(configPath, { required = true } = {}) {
  const resolvedPath = path.resolve(String(configPath || DEFAULT_CONFIG_PATH));
  if (!fs.existsSync(resolvedPath)) {
    if (!required) return null;
    throw new Error(`STAR config file not found: ${resolvedPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  if (!Array.isArray(raw?.datasets) || raw.datasets.length === 0) {
    throw new Error(`STAR config must contain a non-empty datasets array: ${resolvedPath}`);
  }
  return {
    configPath: resolvedPath,
    datasets: raw.datasets.map((entry) => {
      const dir = path.resolve(String(entry?.dir || entry?.path || ""));
      return {
        ...entry,
        dir,
        folderName: String(entry?.folderName || path.basename(dir)),
      };
    }),
  };
}

function resolveCliCatalog(options = {}) {
  const docsRoot = options["docs-root"];
  if (docsRoot) {
    return {
      docsRoot: path.resolve(String(docsRoot)),
      catalogEntries: null,
      source: "docs-root",
    };
  }
  const configPath = options.config || options["config-path"] || DEFAULT_CONFIG_PATH;
  const config = loadSkillConfig(configPath, { required: true });
  return {
    docsRoot: null,
    catalogEntries: config.datasets,
    configPath: config.configPath,
    source: "config",
  };
}

function compactPeekList(items, { docsRoot, catalogEntries, version, languages }) {
  const nativeMetaBundle = loadNativeSearchMetaBundle({ docsRoot, catalogEntries, version, languages });
  return (items || []).map((item) => {
    const nativeMeta = chooseNativeSearchMeta(item, nativeMetaBundle, languages);
    return {
      index: item.index,
      pageId: item.pageId,
      title: nativeMeta?.title || item.title,
      breadcrumb: nativeMeta?.breadcrumb || [],
      breadcrumbTail: nativeMeta?.breadcrumbTail || [],
      contextLine: nativeMeta?.contextLine || "",
      matchedKeywords: item.matchedKeywords || [],
      missingKeywords: item.missingKeywords || [],
      languages: item.languages || (item.language ? [item.language] : []),
    };
  });
}

function pageIdFromRelPath(relPath) {
  return path.basename(String(relPath || "")).replace(/\.html?$/i, "").split("#", 1)[0];
}

function mergeNativePeekResults(searchRuns, { docsRoot, catalogEntries, version, languages, peekLimit, queryTermsByLanguage = {} }) {
  const merged = new Map();
  for (const run of searchRuns) {
    for (const item of run.results || []) {
      const pageId = pageIdFromRelPath(item.relPath);
      if (!pageId) continue;
      const key = `${pageId}::${item.version}`;
      const prior = merged.get(key);
      const next = prior || {
        pageId,
        title: item.title,
        language: item.language,
        languages: [],
        relPath: item.relPath,
        score: 0,
        matchedKeywordsByLanguage: {},
      };
      next.score += Number(item.score || 0);
      next.title = next.title || item.title;
      next.relPath = next.relPath || item.relPath;
      next.language = next.language || item.language;
      next.languages = uniq([...(next.languages || []), item.language]);
      const lang = item.language || "en";
      const priorMatched = new Set(next.matchedKeywordsByLanguage[lang] || []);
      for (const keyword of item.matchedTokens || []) priorMatched.add(keyword);
      next.matchedKeywordsByLanguage[lang] = [...priorMatched];
      merged.set(key, next);
    }
  }

  const ranked = [...merged.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.title.localeCompare(b.title);
    })
    .slice(0, Math.min(Math.max(Number(peekLimit || 12), 1), 24))
    .map((item, index) => ({
      index: index + 1,
      pageId: item.pageId,
      title: item.title,
      language: item.language,
      languages: item.languages,
      relPath: item.relPath,
      matchedKeywordsByLanguage: item.matchedKeywordsByLanguage,
    }));
  const compact = compactPeekList(ranked, { docsRoot, catalogEntries, version, languages });
  return compact.map((item, index) => {
    const rankedItem = ranked[index];
    const preferredLanguage = rankedItem.language || item.languages?.[0] || languages?.[0] || "en";
    const expectedKeywords = queryTermsByLanguage[preferredLanguage] || [];
    const matchedKeywords = uniq(rankedItem.matchedKeywordsByLanguage?.[preferredLanguage] || []);
    const missingKeywords = expectedKeywords.filter((keyword) => !matchedKeywords.includes(keyword));
    return {
      ...item,
      matchedKeywords,
      missingKeywords,
    };
  });
}

function resolveReadsByPageIds({ docsRoot, catalogEntries, pageIds, versions, languages, query = "", maxChars = 12000 }) {
  const targets = (catalogEntries && catalogEntries.length > 0 ? catalogEntries : scanCatalog(docsRoot)).filter((item) => {
    const versionOk = versions.length === 0 || versions.includes(item.version);
    const languageOk = languages.length === 0 || languages.includes(item.language);
    return versionOk && languageOk;
  });
  const reads = [];
  const seen = new Set();
  for (const pageId of pageIds) {
    const relPath = `${pageId}.html`;
    for (const target of targets) {
      const absolutePath = path.join(target.dir, relPath);
      if (!fs.existsSync(absolutePath)) continue;
      const readKey = `${target.folderName}/${relPath}`;
      if (seen.has(readKey)) continue;
      seen.add(readKey);
      const read = readDocument({
        docsRoot,
        catalogEntries,
        folderName: target.folderName,
        relPath,
        query,
        maxChars,
      });
      reads.push({
        pageId,
        title: read.title,
        language: read.language,
        version: read.version,
        folderName: read.folderName,
        relPath,
        textLength: read.textLength,
        excerpt: read.excerpt,
        text: read.text,
      });
    }
  }
  return reads;
}

function printHelp() {
  console.log([
    "Usage:",
    "  node scripts/starccm-cli.mjs graph-peek --config ./starccm-expert.json --query-list-json '[\"...\"]' [--query-list-json-zh '[\"...\"]'] [--query-list-json-en '[\"...\"]'] [--versions 18.04|20.06] [--languages en|zh|zh,en]",
    "  node scripts/starccm-cli.mjs graph-read --config ./starccm-expert.json --page-ids-json '[\"GUID-...\"]' [--versions 18.04|20.06] [--languages zh,en]",
    "  node scripts/starccm-cli.mjs graph-read --config ./starccm-expert.json --page-id GUID-... [--version 18.04] [--language en]",
    "",
    "Notes:",
    "- This Codex-side CLI is local-only and does not call any LLM.",
    "- For STAR 18.04 and 20.06, this CLI intentionally exposes only peek (graph-peek) and read (graph-read).",
    "- Agent planning should happen outside this CLI.",
    "- Dataset locations come from --config by default; --docs-root remains a manual override for compatibility.",
    "- graph-read accepts both singular and plural aliases: --page-id/--page-ids/--page-ids-json and --version(s), --language(s).",
  ].join("\n"));
}

function ensureGraphPeekInputs({ docsRoot, catalogEntries, versions, languages }) {
  const normalizedVersions = parseList(versions, ["18.04"]);
  const normalizedLanguages = parseList(languages, ["en"]);
  if (normalizedVersions.length !== 1 || !SUPPORTED_GRAPH_VERSIONS.has(normalizedVersions[0])) {
    throw new Error("graph-peek currently supports only --versions 18.04 or 20.06");
  }
  if (normalizedLanguages.length < 1 || normalizedLanguages.length > 2 || !normalizedLanguages.every((item) => item === "en" || item === "zh")) {
    throw new Error("graph-peek currently supports only --languages en, zh, or zh,en");
  }
  const version = normalizedVersions[0];
  const targets = (catalogEntries && catalogEntries.length > 0 ? catalogEntries : scanCatalog(docsRoot)).filter((item) => (
    item.version === version && normalizedLanguages.includes(item.language)
  ));
  const missingLanguages = normalizedLanguages.filter((language) => !targets.some((item) => item.language === language));
  if (missingLanguages.length > 0) {
    throw new Error(`graph-peek datasets missing for version=${version}: ${missingLanguages.join(", ")}`);
  }
  const missing = targets.flatMap((target) => {
    const indexDir = path.join(target.dir, "oxygen-webhelp", "app", "search", "index");
    return [
      target.dir,
      path.join(indexDir, "htmlFileInfoList.js"),
      path.join(indexDir, "link-to-parent.js"),
      path.join(indexDir, "stopwords.js"),
      path.join(indexDir, "index-1.js"),
      path.join(indexDir, "index-2.js"),
      path.join(indexDir, "index-3.js"),
    ];
  }).filter((filePath) => !fs.existsSync(filePath));
  if (missing.length > 0) {
    throw new Error(`graph-peek prerequisites missing: ${missing.join(", ")}`);
  }
  return { version, normalizedLanguages };
}

function runGraphPeek({ docsRoot, catalogEntries, options }) {
  const { version, normalizedLanguages } = ensureGraphPeekInputs({
    docsRoot,
    catalogEntries,
    versions: options.versions,
    languages: options.languages,
  });
  const queryList = options.queryListJson || options["query-list-json"] || "";
  const queryListZh = options.queryListJsonZh || options["query-list-json-zh"] || "";
  const queryListEn = options.queryListJsonEn || options["query-list-json-en"] || "";
  const legacyQuery = options.query || "";
  const queriesDefault = queryList ? JSON.parse(queryList) : (legacyQuery ? [legacyQuery] : []);
  const queriesZhProvided = queryListZh ? JSON.parse(queryListZh) : [];
  const queriesEnProvided = queryListEn ? JSON.parse(queryListEn) : [];
  if (queriesDefault.length === 0 && queriesZhProvided.length === 0 && queriesEnProvided.length === 0) {
    throw new Error("graph-peek requires --query-list-json or language-specific query lists");
  }

  const searchRuns = [];
  const queriesByLanguage = {};
  const queryTermsByLanguage = {};
  for (const language of normalizedLanguages) {
    const languageQueries = language === "zh"
      ? (queriesZhProvided.length > 0 ? queriesZhProvided : queriesDefault)
      : (queriesEnProvided.length > 0 ? queriesEnProvided : queriesDefault);
    if (languageQueries.length === 0) continue;
    queriesByLanguage[language] = languageQueries;
    queryTermsByLanguage[language] = tokenizeQueryList(languageQueries);
    for (const query of languageQueries) {
      searchRuns.push(searchAcrossDatasets({
        docsRoot,
        catalogEntries,
        query,
        versions: [version],
        languages: [language],
        topK: Number(options.peekLimit || options["peek-limit"] || 12),
        includeStructural: false,
        includeExcerpt: false,
      }));
    }
  }
  const displayQuery = legacyQuery || uniq(Object.values(queriesByLanguage).flat()).join(" | ");
  const languages = parseList(options.languages, ["en"]);
  const payload = {
    summary: {
      query: displayQuery,
      queriesByLanguage,
      languageCount: normalizedLanguages.length,
      peekCount: searchRuns.reduce((sum, run) => sum + ((run.results || []).length), 0),
    },
    peekList: mergeNativePeekResults(searchRuns, {
      docsRoot,
      catalogEntries,
      version,
      languages,
      peekLimit: Number(options.peekLimit || options["peek-limit"] || 12),
      queryTermsByLanguage,
    }),
  };
  console.log(safeJson(payload));
}

function runGraphRead({ docsRoot, catalogEntries, options }) {
  const pageIds = uniq([
    ...parseList(options.pageId || options["page-id"] || ""),
    ...parseList(options.pageIds || options["page-ids"] || ""),
    ...parseJsonList(options.pageIdsJson || options["page-ids-json"] || "[]"),
  ]);
  if (pageIds.length === 0) {
    throw new Error("graph-read requires --page-ids or --page-ids-json");
  }
  const versions = parseList(options.versions || options.version, ["18.04"]);
  const languages = parseList(options.languages || options.language, ["zh", "en"]);
  const reads = resolveReadsByPageIds({
    docsRoot,
    catalogEntries,
    pageIds,
    versions,
    languages,
    query: options.query || "",
    maxChars: Number(options.maxChars || 12000),
  });

  console.log(safeJson({
    pageIds,
    reads,
  }));
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));

  if (command === "help" || command === "--help" || command === "-h" || options.help) {
    printHelp();
    return;
  }

  const catalog = resolveCliCatalog(options);

  if (command === "graph-peek") {
    runGraphPeek({ ...catalog, options });
    return;
  }

  if (command === "graph-read") {
    runGraphRead({ ...catalog, options });
    return;
  }

  throw new Error(`Unsupported STAR CLI command: ${command}. Only graph-peek and graph-read are exposed.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

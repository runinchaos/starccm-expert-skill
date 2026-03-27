import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = "/root/.codex/skills/starccm-expert/scripts/starccm-cli.mjs";

function createNativeSearchFixture() {
  const docsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "star-native-search-"));
  const datasetDir = path.join(docsRoot, "en_STARCCMP_18.04");
  const indexDir = path.join(datasetDir, "oxygen-webhelp", "app", "search", "index");
  fs.mkdirSync(indexDir, { recursive: true });

  fs.writeFileSync(
    path.join(indexDir, "htmlFileInfoList.js"),
    'define(function () { return ["GUID-PARENT.html@@@Physics Simulation@@@Parent topic...","GUID-TEST.html@@@Wall Boiling Model Reference@@@Native short description for wall boiling initial conditions..."]; });',
    "utf8",
  );
  fs.writeFileSync(
    path.join(indexDir, "link-to-parent.js"),
    "define(function () { return {0:-1,1:0}; });",
    "utf8",
  );
  fs.writeFileSync(
    path.join(indexDir, "stopwords.js"),
    "define(function () { return []; });",
    "utf8",
  );
  fs.writeFileSync(
    path.join(indexDir, "index-1.js"),
    'define(function () { return {"wall":"1*5*1$2","boiling":"1*5*1$2","initial":"1*4*1","conditions":"1*4*2"}; });',
    "utf8",
  );
  fs.writeFileSync(path.join(indexDir, "index-2.js"), "define(function () { return {}; });", "utf8");
  fs.writeFileSync(path.join(indexDir, "index-3.js"), "define(function () { return {}; });", "utf8");
  fs.writeFileSync(
    path.join(datasetDir, "GUID-TEST.html"),
    "<html><body><main><article><h1>Wall Boiling Model Reference</h1><p>Native short description for wall boiling initial conditions.</p><p>The wall boiling model requires initial conditions to be set for the relevant phases.</p></article></main></body></html>",
    "utf8",
  );

  return docsRoot;
}

function writeConfigFile(datasets) {
  const configPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "star-config-")),
    "starccm-expert.json",
  );
  fs.writeFileSync(
    configPath,
    JSON.stringify({ datasets }, null, 2),
    "utf8",
  );
  return configPath;
}

test("graph-peek command returns structured output for en 18.04", () => {
  const result = spawnSync(
    "node",
    [
      CLI,
      "graph-peek",
      "--query-list-json", '["wall boiling","initial conditions"]',
      "--versions", "18.04",
      "--languages", "en",
      "--deepReadTop", "0",
      "--promoteLimit", "4",
    ],
    {
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.summary.queriesByLanguage.en.length, 2);
  assert.ok(payload.summary.peekCount >= 1, result.stdout);
  assert.ok(Array.isArray(payload.peekList));
  assert.equal(payload.peekList[0].index, 1);
  assert.ok(payload.peekList[0].pageId);
  assert.ok(payload.peekList[0].title);
  assert.ok(Array.isArray(payload.peekList[0].breadcrumb), result.stdout);
  assert.ok(Array.isArray(payload.peekList[0].breadcrumbTail), result.stdout);
  assert.ok(payload.peekList[0].breadcrumb.every((item) => item && typeof item.title === "string" && typeof item.pageId === "string" && typeof item.relPath === "string"), result.stdout);
  assert.ok(Array.isArray(payload.peekList[0].matchedKeywords), result.stdout);
  assert.ok(Array.isArray(payload.peekList[0].missingKeywords), result.stdout);
  assert.equal(typeof payload.peekList[0].contextLine, "string");
  assert.ok(Object.keys(payload.peekList[0]).every((key) => ["index", "pageId", "title", "breadcrumb", "breadcrumbTail", "contextLine", "matchedKeywords", "missingKeywords", "languages"].includes(key)));
  assert.equal(payload.seeds, undefined);
  assert.equal(payload.triage, undefined);
});

test("graph-peek command supports bilingual zh,en on 18.04", () => {
  const result = spawnSync(
    "node",
    [
      CLI,
      "graph-peek",
      "--query-list-json-zh", '["壁面沸腾","初始条件"]',
      "--query-list-json-en", '["wall boiling","initial conditions"]',
      "--versions", "18.04",
      "--languages", "zh,en",
      "--deepReadTop", "2",
      "--promoteLimit", "4",
    ],
    {
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.summary.languageCount, 2);
  assert.deepEqual(payload.summary.queriesByLanguage.zh, ["壁面沸腾", "初始条件"]);
  assert.deepEqual(payload.summary.queriesByLanguage.en, ["wall boiling", "initial conditions"]);
  assert.ok(Array.isArray(payload.peekList));
  assert.ok(payload.peekList.some((item) => Array.isArray(item.languages) && item.languages.length >= 1), result.stdout);
  assert.equal(payload.peekList[0].index, 1);
  assert.ok(payload.peekList[0].pageId);
  assert.ok(Array.isArray(payload.peekList[0].breadcrumb), result.stdout);
  assert.ok(Array.isArray(payload.peekList[0].breadcrumbTail), result.stdout);
  assert.equal(typeof payload.peekList[0].contextLine, "string");
});

test("graph-read command reads selected page ids", () => {
  const pipeline = spawnSync(
    "node",
    [
      CLI,
      "graph-peek",
      "--query-list-json", '["wall boiling","initial conditions"]',
      "--versions", "18.04",
      "--languages", "en",
      "--promoteLimit", "4",
    ],
    {
      encoding: "utf8",
    },
  );

  assert.equal(pipeline.status, 0, pipeline.stderr || pipeline.stdout);
  const summary = JSON.parse(pipeline.stdout);
  const pageId = summary.peekList[0].pageId;
  const read = spawnSync(
    "node",
    [
      CLI,
      "graph-read",
      "--page-ids-json", JSON.stringify([pageId]),
      "--versions", "18.04",
      "--languages", "en",
    ],
    {
      encoding: "utf8",
    },
  );

  assert.equal(read.status, 0, read.stderr || read.stdout);
  const payload = JSON.parse(read.stdout);
  assert.deepEqual(payload.pageIds, [pageId]);
  assert.equal(payload.reads.length, 1);
  assert.equal(payload.reads[0].pageId, pageId);
  assert.ok(payload.reads[0].textLength > 0, read.stdout);
});

test("graph-peek command supports en 20.06", () => {
  const result = spawnSync(
    "node",
    [
      CLI,
      "graph-peek",
      "--query-list-json", '["thermal comfort model","initial conditions"]',
      "--versions", "20.06",
      "--languages", "en",
      "--deepReadTop", "0",
      "--promoteLimit", "4",
    ],
    {
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.summary.queriesByLanguage.en.length, 2);
  assert.ok(payload.summary.peekCount >= 1, result.stdout);
  assert.ok(Array.isArray(payload.peekList));
  assert.equal(payload.peekList[0].index, 1);
  assert.ok(payload.peekList[0].pageId);
  assert.ok(Array.isArray(payload.peekList[0].breadcrumb), result.stdout);
  assert.ok(Array.isArray(payload.peekList[0].breadcrumbTail), result.stdout);
  assert.equal(typeof payload.peekList[0].contextLine, "string");
});

test("graph-peek and graph-read work without graph assets when native search files exist", () => {
  const docsRoot = createNativeSearchFixture();
  const peek = spawnSync(
    "node",
    [
      CLI,
      "graph-peek",
      "--docs-root", docsRoot,
      "--query-list-json", '["wall boiling","initial conditions"]',
      "--versions", "18.04",
      "--languages", "en",
    ],
    {
      encoding: "utf8",
    },
  );

  assert.equal(peek.status, 0, peek.stderr || peek.stdout);
  const peekPayload = JSON.parse(peek.stdout);
  assert.equal(peekPayload.peekList[0].pageId, "GUID-TEST");
  assert.equal(peekPayload.peekList[0].contextLine, "Native short description for wall boiling initial conditions...");
  assert.deepEqual(peekPayload.peekList[0].breadcrumb, [
    {
      title: "Physics Simulation",
      pageId: "GUID-PARENT",
      relPath: "GUID-PARENT.html",
    },
  ]);
  assert.deepEqual(peekPayload.peekList[0].matchedKeywords.sort(), ["boiling", "conditions", "initial", "wall"]);
  assert.deepEqual(peekPayload.peekList[0].missingKeywords, []);

  const read = spawnSync(
    "node",
    [
      CLI,
      "graph-read",
      "--docs-root", docsRoot,
      "--page-ids-json", '["GUID-TEST"]',
      "--versions", "18.04",
      "--languages", "en",
    ],
    {
      encoding: "utf8",
    },
  );

  assert.equal(read.status, 0, read.stderr || read.stdout);
  const readPayload = JSON.parse(read.stdout);
  assert.equal(readPayload.reads[0].pageId, "GUID-TEST");
  assert.match(readPayload.reads[0].text, /requires initial conditions/i);
});

test("graph-peek and graph-read can resolve datasets from config without docs-root", () => {
  const docsRoot = createNativeSearchFixture();
  const configPath = writeConfigFile([
    {
      path: path.join(docsRoot, "en_STARCCMP_18.04"),
      version: "18.04",
      language: "en",
    },
  ]);

  const peek = spawnSync(
    "node",
    [
      CLI,
      "graph-peek",
      "--config", configPath,
      "--query-list-json", '["wall boiling","initial conditions"]',
      "--versions", "18.04",
      "--languages", "en",
    ],
    {
      encoding: "utf8",
    },
  );

  assert.equal(peek.status, 0, peek.stderr || peek.stdout);
  const peekPayload = JSON.parse(peek.stdout);
  assert.equal(peekPayload.peekList[0].pageId, "GUID-TEST");

  const read = spawnSync(
    "node",
    [
      CLI,
      "graph-read",
      "--config", configPath,
      "--page-ids-json", '["GUID-TEST"]',
      "--versions", "18.04",
      "--languages", "en",
    ],
    {
      encoding: "utf8",
    },
  );

  assert.equal(read.status, 0, read.stderr || read.stdout);
  const readPayload = JSON.parse(read.stdout);
  assert.equal(readPayload.reads[0].pageId, "GUID-TEST");
});

test("graph-peek fails clearly when neither config nor docs-root is provided", () => {
  const missingConfigPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "star-missing-config-")),
    "starccm-expert.json",
  );
  const result = spawnSync(
    "node",
    [
      CLI,
      "graph-peek",
      "--config", missingConfigPath,
      "--query-list-json", '["wall boiling"]',
      "--versions", "18.04",
      "--languages", "en",
    ],
    {
      encoding: "utf8",
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /(config|dataset|docs-root|not configured|missing)/i,
  );
});

test("graph-read supports intuitive singular aliases and single page-id", () => {
  const docsRoot = createNativeSearchFixture();
  const configPath = writeConfigFile([
    {
      path: path.join(docsRoot, "en_STARCCMP_18.04"),
      version: "18.04",
      language: "en",
    },
  ]);

  const read = spawnSync(
    "node",
    [
      CLI,
      "graph-read",
      "--config", configPath,
      "--page-id", "GUID-TEST",
      "--version", "18.04",
      "--language", "en",
    ],
    {
      encoding: "utf8",
    },
  );

  assert.equal(read.status, 0, read.stderr || read.stdout);
  const payload = JSON.parse(read.stdout);
  assert.deepEqual(payload.pageIds, ["GUID-TEST"]);
  assert.equal(payload.reads[0].pageId, "GUID-TEST");
});

test("graph-read supports scalar --page-ids as a comma list", () => {
  const docsRoot = createNativeSearchFixture();
  const configPath = writeConfigFile([
    {
      path: path.join(docsRoot, "en_STARCCMP_18.04"),
      version: "18.04",
      language: "en",
    },
  ]);

  const read = spawnSync(
    "node",
    [
      CLI,
      "graph-read",
      "--config", configPath,
      "--page-ids", "GUID-TEST",
      "--versions", "18.04",
      "--languages", "en",
    ],
    {
      encoding: "utf8",
    },
  );

  assert.equal(read.status, 0, read.stderr || read.stdout);
  const payload = JSON.parse(read.stdout);
  assert.deepEqual(payload.pageIds, ["GUID-TEST"]);
});

test("graph-read --help prints help instead of validating required args", () => {
  const result = spawnSync(
    "node",
    [
      CLI,
      "graph-read",
      "--help",
    ],
    {
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /graph-read/);
});

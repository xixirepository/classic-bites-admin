#!/usr/bin/env node
"use strict";

// Exercise the actual editor and dialog controllers without a server.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function fixture({ respond } = {}) {
  const elements = new Map();
  let document;
  class Element {
    constructor(tag = "div") {
      this.tagName = tag;
      this.listeners = new Map();
      this.children = [];
      this.files = [];
      this.textContent = "";
      this.value = "";
      this.checked = false;
      this.disabled = false;
      this.attributes = new Map();
      this.hidden = false;
      this.isConnected = true;
      this.open = false;
      this.returnValue = "";
      this.classList = { toggle() {} };
    }
    set id(value) { this._id = value; elements.set(value, this); }
    get id() { return this._id; }
    addEventListener(type, handler) {
      const list = this.listeners.get(type) || [];
      list.push(handler);
      this.listeners.set(type, list);
    }
    emit(type) {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      for (const handler of this.listeners.get(type) || []) handler(event);
      return event;
    }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close(result) {
      if (!this.open) return;
      this.returnValue = result;
      this.open = false;
      queueMicrotask(() => this.emit("close"));
    }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; this.textContent = ""; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    querySelectorAll(selector) {
      const tags = selector.split(",");
      return this.children.flatMap((child) => [
        ...(tags.includes(child.tagName) ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    }
    scrollIntoView() {}
    setCustomValidity(value) { this.validationMessage = value; }
    reportValidity() { return !this.validationMessage; }
  }
  document = {
    activeElement: new Element("button"),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement(tag) { return new Element(tag); },
  };
  const requests = [];
  const window = { addEventListener() {}, setTimeout, clearTimeout, matchMedia: () => ({ matches: false }) };
  const context = {
    document, window, URL, Headers, AbortController, setTimeout, clearTimeout,
    FormData: class {
      constructor(form) { this.form = form; }
      entries() {
        return this.form.querySelectorAll("input,textarea,select")
          .filter((field) => field.name && !field.disabled && (field.type !== "checkbox" || field.checked))
          .map((field) => [field.name, field.type === "checkbox" ? "on" : field.value])[Symbol.iterator]();
      }
    },
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url) !== "/config.json" && respond) {
        const result = await respond(String(url), options);
        if (result) return { ok: result.status === undefined || result.status < 400, status: result.status || 200, headers: new Headers(), json: async () => result.body };
      }
      return { ok: true, status: 200, json: async () => String(url) === "/config.json" ? { api_base_url: "https://api.example.com" } : { items: [] } };
    },
  };
  const source = readFileSync(resolve(__dirname, "../admin/static/app.js"), "utf8");
  const instrumented = source.replace(/\}\)\(\);\s*$/, "globalThis.controller = { confirmAction, allowDiscard, navigate, togglePublication, expireSession, state, errorText, editEntity, saveEntity, hasUnsaved, renderCatalog, signIn };\n})();");
  assert.notEqual(instrumented, source, "The controller test hook must match the app wrapper.");
  vm.runInNewContext(instrumented, context, { filename: "app.js" });
  const controller = context.controller;
  controller.state.apiOrigin = "https://api.example.com";
  controller.state.accessToken = "TEST_ONLY";
  return { ...controller, document, requests, element: (id) => document.getElementById(id) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("confirmation defaults to cancel, keeps literal text, and restores focus", async () => {
  const ui = fixture();
  const previousFocus = ui.document.activeElement;
  const pending = ui.confirmAction({ title: "공개 확인", message: "<img src=x onerror=alert(1)>", acceptLabel: "공개하기" });
  assert.equal(ui.element("confirmation-dialog").open, true);
  assert.equal(ui.document.activeElement, ui.element("confirmation-cancel"));
  assert.equal(ui.element("confirmation-message").textContent, "<img src=x onerror=alert(1)>");
  assert.equal(ui.element("confirmation-message").children.length, 0);
  ui.element("confirmation-cancel").emit("click");
  assert.equal(await pending, false);
  assert.equal(ui.element("confirmation-dialog").open, false);
  assert.equal(ui.document.activeElement, previousFocus);
});

test("accept resolves true; a later Escape resolves false and never reuses acceptance", async () => {
  const ui = fixture();
  const accepted = ui.confirmAction({ title: "확인", message: "첫 요청" });
  ui.element("confirmation-accept").emit("click");
  assert.equal(await accepted, true);
  const canceled = ui.confirmAction({ title: "확인", message: "다음 요청" });
  assert.equal(ui.element("confirmation-dialog").emit("cancel").defaultPrevented, true);
  assert.equal(await canceled, false);
  assert.equal(ui.element("confirmation-dialog").open, false);
});

test("a second dialog or an in-flight save cannot start another confirmation", async () => {
  const ui = fixture();
  const first = ui.confirmAction({ title: "원래 제목", message: "원래 요청" });
  assert.equal(await ui.confirmAction({ title: "중복 제목", message: "중복 요청" }), false);
  assert.equal(ui.element("confirmation-title").textContent, "원래 제목");
  ui.element("confirmation-cancel").emit("click");
  await first;
  ui.state.saving = true;
  assert.equal(await ui.confirmAction({ title: "저장 중", message: "요청" }), false);
  assert.equal(ui.element("confirmation-dialog").open, false);
});

test("canceling unsaved navigation preserves the draft and makes no content request", async () => {
  const ui = fixture();
  const draft = { kind: "books", record: null };
  const data = { items: [] };
  ui.state.editor = draft;
  ui.state.editorBaseline = "unchanged baseline";
  ui.state.data = data;
  const pending = ui.navigate([]);
  assert.equal(ui.element("confirmation-dialog").open, true);
  assert.equal(ui.state.data, data);
  ui.element("confirmation-cancel").emit("click");
  await pending;
  assert.equal(ui.state.editor, draft);
  assert.equal(ui.state.data, data);
  assert.equal(ui.requests.filter((request) => request.url.includes("/admin/api/")).length, 0);
});

test("publication waits for approval; cancel and duplicate clicks never send PUT", async () => {
  const ui = fixture();
  const record = { id: "BOOK_ID", title: "사서오경", sort_order: 0, is_published: false };
  const pending = ui.togglePublication("books", record);
  await tick();
  assert.equal(ui.element("confirmation-dialog").open, true);
  const duplicate = ui.togglePublication("books", record);
  ui.element("confirmation-cancel").emit("click");
  await Promise.all([pending, duplicate]);
  assert.equal(ui.requests.filter((request) => request.options?.method === "PUT").length, 0);
  assert.equal(ui.state.saving, false);
});

test("publication acceptance sends exactly one change", async () => {
  const ui = fixture();
  const pending = ui.togglePublication("books", { id: "BOOK_ID", title: "사서오경", sort_order: 0, is_published: false });
  await tick();
  ui.element("confirmation-accept").emit("click");
  await pending;
  const writes = ui.requests.filter((request) => request.options?.method === "PUT");
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].options.body).is_published, true);
  assert.equal(ui.state.saving, false);
});

test("session expiration cancels a pending action and keeps focus at login", async () => {
  const ui = fixture();
  const pending = ui.togglePublication("books", { id: "BOOK_ID", title: "사서오경", sort_order: 0, is_published: false });
  await tick();
  ui.expireSession();
  await pending;
  assert.equal(ui.element("confirmation-dialog").open, false);
  assert.equal(ui.requests.filter((request) => request.options?.method === "PUT").length, 0);
  assert.equal(ui.state.accessToken, null);
  assert.equal(ui.document.activeElement, ui.element("email"));
});

test("oversized content and cover errors have distinct guidance", () => {
  const ui = fixture();
  assert.match(ui.errorText({ status: 413, code: "cover_too_large" }), /5 MiB/);
  assert.doesNotMatch(ui.errorText({ status: 413, code: "request_too_large" }), /표지|5 MiB/);
});

const submit = { preventDefault() {} };
const work = {
  id: "WORK_ID", book_id: "BOOK_ID", title: "대학", description: "기존 소개",
  title_hanzi: "大學", title_pinyin: "Dà xué", source_edition: "검증용 판본",
  source_url: "https://example.com/source", pinyin_source: "검증용 병음 기록",
  review_status: "draft", sort_order: 10, is_published: false,
};
const bite = {
  id: "BITE_ID", chapter_id: "CHAPTER_ID", title: "첫 문장", sort_order: 10,
  original: "大學之道", pinyin: "Dà xué zhī dào", translation: "기존 번역",
  commentary: "기존 해설", is_published: false,
};
const textTree = (element) => [element.textContent, ...element.children.map(textTree)].join("\n");

test("work save round-trips hanzi, tone marks and source metadata while preserving Korean fields", async () => {
  let saved;
  const ui = fixture({ respond: (_, options) => {
    if (options.method === "PUT") {
      saved = { id: work.id, ...JSON.parse(options.body) };
      return { body: { work: saved } };
    }
  } });
  ui.state.data = { items: [] };
  await ui.editEntity("works", work);
  assert.equal(ui.element("field-title_hanzi").value, "大學");
  assert.equal(ui.element("field-title_pinyin").value, "Dà xué");
  assert.equal(ui.element("field-review_status").value, "draft");
  ui.element("field-title_pinyin").value = "Dà xué · xiū shēn";
  ui.element("field-pinyin_source").value = "성조 검수 진행 중";
  await ui.saveEntity(submit);
  assert.equal(saved.title, work.title);
  assert.equal(saved.description, work.description);
  assert.equal(saved.source_edition, work.source_edition);
  assert.equal(saved.source_url, work.source_url);
  assert.equal(saved.pinyin_source, "성조 검수 진행 중");
  assert.equal(saved.title_pinyin, "Dà xué · xiū shēn");
  assert.equal(saved.review_status, "draft");
  assert.equal(ui.element("field-title_pinyin").value, saved.title_pinyin);
  assert.equal(ui.hasUnsaved(), false);
});

test("new works start as draft and chapters send both title fields", async () => {
  let saved;
  const ui = fixture({ respond: (_, options) => {
    if (options.method === "POST") {
      saved = { id: "CHAPTER_ID", ...JSON.parse(options.body) };
      return { body: { chapter: saved } };
    }
    return { body: { work, chapters: [] } };
  } });
  ui.state.trail = [{ kind: "books", id: "BOOK_ID", title: "사서오경" }];
  ui.state.data = { book: { id: "BOOK_ID" }, works: [] };
  await ui.editEntity("works");
  assert.equal(ui.element("field-review_status").value, "draft");
  ui.state.trail = [{ kind: "works", id: work.id, title: work.title }];
  ui.state.data = { work, chapters: [] };
  await ui.editEntity("chapters", null, { force: true });
  ui.element("field-title").value = "경 1장";
  ui.element("field-title_hanzi").value = "經一章";
  ui.element("field-title_pinyin").value = "Jīng yī zhāng";
  await ui.saveEntity(submit);
  assert.equal(saved.title, "경 1장");
  assert.equal(saved.title_hanzi, "經一章");
  assert.equal(saved.title_pinyin, "Jīng yī zhāng");
  assert.equal(saved.work_id, work.id);
  assert.equal(saved.book_id, work.book_id);
});

test("bite details load pinyin and save it with the original translation and commentary", async () => {
  let saved;
  const ui = fixture({ respond: (url, options) => {
    if (options.method === "PUT") {
      saved = { id: bite.id, ...JSON.parse(options.body) };
      return { body: { bite: saved } };
    }
    if (url.endsWith(`/bites/${bite.id}`)) return { body: { bite } };
  } });
  ui.state.data = { items: [] };
  await ui.editEntity("bites", { id: bite.id });
  assert.equal(ui.element("field-pinyin").value, bite.pinyin);
  const names = ui.element("editor-form").querySelectorAll("input,textarea,select").map((field) => field.name);
  assert.equal(names.indexOf("pinyin"), names.indexOf("original") + 1);
  ui.element("field-pinyin").value = "Dà xué zhī dào\nzài míng míng dé";
  await ui.saveEntity(submit);
  assert.equal(saved.original, bite.original);
  assert.equal(saved.translation, bite.translation);
  assert.equal(saved.commentary, bite.commentary);
  assert.equal(saved.pinyin, "Dà xué zhī dào\nzài míng míng dé");
  assert.equal(ui.element("field-pinyin").value, saved.pinyin);
});

test("failed save keeps all edited fields and reports the error without losing the draft", async () => {
  const ui = fixture({ respond: (_, options) => options.method === "PUT" ? { status: 503, body: {} } : null });
  await ui.editEntity("bites", bite);
  ui.element("field-original").value = "大學之道，在明明德";
  ui.element("field-pinyin").value = "Dà xué zhī dào, zài míng míng dé";
  await ui.saveEntity(submit);
  assert.equal(ui.element("field-original").value, "大學之道，在明明德");
  assert.equal(ui.element("field-pinyin").value, "Dà xué zhī dào, zài míng míng dé");
  assert.equal(ui.element("field-translation").value, bite.translation);
  assert.equal(ui.element("field-commentary").value, bite.commentary);
  assert.equal(ui.hasUnsaved(), true);
  assert.equal(ui.state.saving, false);
  assert.match(ui.element("editor-message").textContent, /서버가 잠시/);
});

test("session expiry and re-login preserve the edited pinyin", async () => {
  const ui = fixture({ respond: (url, options) => {
    if (options.method === "PUT") return { status: 401, body: {} };
    if (url.endsWith("/auth/login")) return { body: { access_token: "TEST_ONLY", refresh_token: "TEST_REFRESH_ONLY", user: {} } };
  } });
  ui.state.data = { items: [] };
  await ui.editEntity("bites", bite);
  ui.element("field-pinyin").value = "초안 Dà xué";
  await ui.saveEntity(submit);
  assert.equal(ui.state.sessionExpired, true);
  ui.element("email").value = "test@example.com";
  ui.element("password").value = "TEST_ONLY";
  await ui.signIn(submit);
  assert.equal(ui.state.sessionExpired, false);
  assert.equal(ui.element("field-pinyin").value, "초안 Dà xué");
  assert.equal(ui.hasUnsaved(), true);
});

test("publication toggle preserves pinyin and work metadata", async () => {
  for (const [kind, record] of [["works", work], ["bites", bite]]) {
    const ui = fixture();
    const pending = ui.togglePublication(kind, record);
    await tick();
    ui.element("confirmation-accept").emit("click");
    await pending;
    const payload = JSON.parse(ui.requests.find((request) => request.options?.method === "PUT").options.body);
    if (kind === "works") {
      for (const field of ["title_hanzi", "title_pinyin", "source_edition", "source_url", "pinyin_source", "review_status"]) assert.equal(payload[field], record[field]);
    } else {
      for (const field of ["original", "pinyin", "translation", "commentary"]) assert.equal(payload[field], record[field]);
    }
    assert.equal(payload.is_published, true);
  }
});

test("live and saved previews pair literal hanzi with pinyin, including empty and long values", async () => {
  const ui = fixture();
  await ui.editEntity("bites", bite);
  const literal = "<img src=x onerror=alert(1)>";
  const longPinyin = "Dà xué zhī dào\n".repeat(200);
  ui.element("field-original").value = literal;
  ui.element("field-pinyin").value = longPinyin;
  ui.element("editor-form").emit("input");
  const preview = ui.element("editor-reading-preview").children[0];
  assert.equal(preview.children[1].textContent, literal);
  assert.equal(preview.children[1].children.length, 0);
  assert.equal(preview.children[2].textContent, longPinyin);
  ui.element("field-pinyin").value = "";
  ui.element("editor-form").emit("input");
  assert.match(textTree(ui.element("editor-reading-preview")), /아직 입력한 병음이 없어요/);
  ui.state.trail = [{ kind: "bites", id: bite.id, title: bite.title }];
  ui.state.data = { bite };
  ui.renderCatalog();
  const savedPreview = ui.element("catalog-panel").children[1];
  assert.equal(savedPreview.children[1].textContent, bite.original);
  assert.equal(savedPreview.children[2].textContent, bite.pinyin);
});

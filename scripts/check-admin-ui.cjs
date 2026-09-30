#!/usr/bin/env node
"use strict";

// Exercise the actual dialog controller and its async callers without a server.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function fixture() {
  const elements = new Map();
  let document;
  class Element {
    constructor(tag = "div") {
      this.tagName = tag;
      this.listeners = new Map();
      this.children = [];
      this.files = [];
      this.textContent = "";
      this.hidden = false;
      this.isConnected = true;
      this.open = false;
      this.returnValue = "";
      this.classList = { toggle() {} };
    }
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
    setAttribute() {}
    querySelectorAll() { return []; }
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
  const window = { addEventListener() {}, setTimeout, clearTimeout };
  const context = {
    document, window, URL, Headers, AbortController, setTimeout, clearTimeout,
    FormData: class {
      entries() { return [["title", "작성 중인 제목"]][Symbol.iterator](); }
    },
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return { ok: true, status: 200, json: async () => String(url) === "/config.json" ? { api_base_url: "https://api.example.com" } : { items: [] } };
    },
  };
  const source = readFileSync(resolve(__dirname, "../admin/static/app.js"), "utf8");
  const instrumented = source.replace(/\}\)\(\);\s*$/, "globalThis.controller = { confirmAction, allowDiscard, navigate, togglePublication, expireSession, state, errorText };\n})();");
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

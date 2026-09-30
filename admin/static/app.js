"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const labels = { books: "책", works: "내부 작품", chapters: "장", bites: "한입" };
  const singular = { books: "book", works: "work", chapters: "chapter", bites: "bite" };
  const state = {
    apiOrigin: null, accessToken: null, refreshToken: null, user: null,
    trail: [], data: null, editor: null, editorBaseline: "", loading: false,
    saving: false, loginPending: false, sessionExpired: false, requestVersion: 0,
    retryAfter: 0, imageURLs: new Set(), imageVersion: 0,
  };
  let confirmation = null;

  class APIError extends Error {
    constructor(status, code, method = "GET") {
      super(code);
      this.status = status;
      this.code = code;
      this.method = method;
    }
  }

  function node(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined && text !== null) result.textContent = String(text);
    return result;
  }

  function button(title, onClick, className = "button") {
    const result = node("button", className, title);
    result.type = "button";
    result.addEventListener("click", onClick);
    return result;
  }

  function setMessage(target, message, isError = false) {
    target.replaceChildren();
    target.hidden = !message;
    target.classList.toggle("message-error", isError);
    if (message) target.textContent = message;
  }

  function tell(message, isError = false) {
    setMessage($("workspace-message"), message, isError);
  }

  function errorText(error) {
    if (error.code === "rate_limited" || error.status === 429) return "요청이 많아 잠시 쉬어야 해요. 잠시 후 다시 시도해주세요.";
    if (error.code === "invalid_credentials") return "이메일과 비밀번호를 확인해주세요.";
    if (error.status === 401) return "로그인 시간이 만료됐어요. 다시 로그인하면 편집을 이어갈 수 있어요.";
    if (error.status === 403) return "이 계정에는 콘텐츠 관리 권한이 없어요. 관리자로 등록된 계정으로 로그인해주세요.";
    if (error.status === 404) return "콘텐츠를 찾을 수 없어요. 목록을 새로고침해주세요.";
    if (error.status === 409) return "현재 내용과 요청이 맞지 않아요. 목록을 새로고침한 뒤 다시 확인해주세요.";
    if (error.status === 413 && error.code === "cover_too_large") return "표지는 5 MiB 이하의 파일을 선택해주세요.";
    if (error.status === 413) return "입력한 내용이 서버의 허용 크기를 넘었어요. 한 번에 저장할 내용의 분량을 줄여주세요.";
    if (error.status === 415) return "PNG, JPEG, WebP 형식의 이미지를 선택해주세요.";
    if (error.status === 422) return "입력한 내용의 형식과 길이를 확인해주세요.";
    if (error.status === 503) return "서버가 잠시 응답하지 못하고 있어요. 잠시 후 다시 시도해주세요.";
    if (error.code === "configuration") return "콘텐츠 서버 연결 설정을 확인할 수 없어요. 관리자 서버의 API 주소를 확인해주세요.";
    if (error.method && error.method !== "GET" && error.status === 0) return "서버의 처리 결과를 확인하지 못했어요. 목록을 새로고침해 반영 여부를 확인한 뒤 다시 저장해주세요.";
    if (error.code === "timeout") return "연결 시간이 오래 걸리고 있어요. 연결 상태를 확인하고 다시 시도해주세요.";
    return "요청을 완료하지 못했어요. 연결 상태를 확인하고 다시 시도해주세요.";
  }

  async function loadConfiguration() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch("/config.json", { credentials: "omit", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("configuration");
      const config = await response.json();
      const url = new URL(config.api_base_url);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("configuration");
      state.apiOrigin = url.origin;
    } catch (_) {
      throw new APIError(0, "configuration");
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function apiURL(path) {
    if (!state.apiOrigin) throw new APIError(0, "configuration");
    const url = new URL(path, `${state.apiOrigin}/`);
    if (url.origin !== state.apiOrigin || url.username || url.password || url.hash) throw new APIError(0, "configuration");
    return url;
  }

  async function request(path, { method = "GET", body, authenticated = true, blob = false } = {}) {
    if (Date.now() < state.retryAfter) throw new APIError(429, "rate_limited", method);
    const url = apiURL(path);
    const token = state.accessToken;
    if (authenticated && !token) throw new APIError(401, "invalid_token", method);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    const headers = new Headers({ Accept: blob ? "image/png, image/jpeg, image/webp" : "application/json" });
    if (authenticated) headers.set("Authorization", `Bearer ${token}`);
    let payload = body;
    if (body !== undefined && !(body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
      payload = JSON.stringify(body);
    }
    try {
      const response = await fetch(url, { method, headers, body: payload, credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal });
      if (!response.ok) {
        let code = "request_failed";
        try {
          const detail = await response.json();
          if (typeof detail?.detail?.code === "string") code = detail.detail.code;
        } catch (_) { /* Raw server errors are never displayed. */ }
        if (response.status === 429) {
          const wait = Number(response.headers.get("Retry-After"));
          state.retryAfter = Date.now() + Math.min(3600, Math.max(1, Number.isFinite(wait) && wait > 0 ? wait : 30)) * 1000;
        }
        if (response.status === 401 && authenticated && token === state.accessToken) expireSession();
        throw new APIError(response.status, code, method);
      }
      if (response.status === 204) return null;
      if (blob) {
        const image = await response.blob();
        if (!["image/png", "image/jpeg", "image/webp"].includes(image.type) || image.size > 5 * 1024 * 1024) throw new APIError(0, "invalid_image", method);
        return image;
      }
      return await response.json();
    } catch (error) {
      if (error instanceof APIError) throw error;
      throw new APIError(0, error.name === "AbortError" ? "timeout" : "network", method);
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function expireSession() {
    cancelConfirmation();
    const refresh = state.refreshToken;
    state.accessToken = null;
    state.refreshToken = null;
    state.user = null;
    state.sessionExpired = true;
    state.requestVersion += 1;
    $("login-panel").hidden = false;
    $("workspace").hidden = true;
    $("session-actions").hidden = true;
    $("password").value = "";
    setMessage($("login-message"), "로그인 시간이 만료됐어요. 다시 로그인하면 작성 중인 내용을 이어갈 수 있어요.", true);
    $("email").focus();
    if (refresh) request("/auth/logout", { method: "POST", authenticated: false, body: { refresh_token: refresh } }).catch(() => {});
  }

  function showWorkspace() {
    $("login-panel").hidden = true;
    $("workspace").hidden = false;
    $("session-actions").hidden = false;
    $("session-name").textContent = state.user?.display_name ? `${state.user.display_name}님` : "관리자";
  }

  async function signIn(event) {
    event.preventDefault();
    if (state.loginPending) return;
    state.loginPending = true;
    $("login-button").disabled = true;
    $("login-button").textContent = "로그인 중…";
    setMessage($("login-message"), "");
    let issuedRefresh = null;
    try {
      if (!state.apiOrigin) await loadConfiguration();
      const tokens = await request("/auth/login", { method: "POST", authenticated: false, body: { email: $("email").value.trim(), password: $("password").value } });
      $("password").value = "";
      if (typeof tokens?.access_token !== "string" || typeof tokens?.refresh_token !== "string") throw new APIError(0, "invalid_response");
      state.accessToken = tokens.access_token;
      issuedRefresh = tokens.refresh_token;
      const books = await request("/admin/api/books");
      if (!Array.isArray(books?.items)) throw new APIError(0, "invalid_response");
      state.refreshToken = tokens.refresh_token;
      state.user = tokens.user;
      const resume = state.sessionExpired && state.data;
      state.sessionExpired = false;
      showWorkspace();
      if (resume) {
        renderCatalog();
        tell("다시 로그인했어요. 작성 중이던 내용을 이어서 저장할 수 있어요.");
      } else {
        state.trail = [];
        state.data = books;
        renderCatalog();
        renderEditorEmpty();
      }
    } catch (error) {
      state.accessToken = null;
      state.refreshToken = null;
      state.user = null;
      $("password").value = "";
      setMessage($("login-message"), errorText(error), true);
      if (issuedRefresh) {
        try { await request("/auth/logout", { method: "POST", authenticated: false, body: { refresh_token: issuedRefresh } }); } catch (_) { /* Rejected admin sessions are discarded locally. */ }
      }
    } finally {
      state.loginPending = false;
      $("login-button").disabled = false;
      $("login-button").textContent = "로그인";
    }
  }

  function current() { return state.trail[state.trail.length - 1] || null; }
  function currentEntity() { const selected = current(); return selected ? state.data?.[singular[selected.kind]] : null; }
  function detailPath(selected) { return selected ? `/admin/api/${selected.kind}/${encodeURIComponent(selected.id)}` : "/admin/api/books"; }

  function formSnapshot() {
    const form = $("editor-form");
    if (!form) return "";
    return JSON.stringify(Array.from(new FormData(form).entries()));
  }

  function hasUnsaved() {
    return Boolean(state.editor && (formSnapshot() !== state.editorBaseline || $("cover-file")?.files?.length));
  }

  function confirmAction({ title, message, acceptLabel = "확인" }) {
    if (confirmation || state.saving) return Promise.resolve(false);
    const dialog = $("confirmation-dialog");
    $("confirmation-title").textContent = title;
    $("confirmation-message").textContent = message;
    $("confirmation-accept").textContent = acceptLabel;
    dialog.returnValue = "cancel";
    return new Promise((resolve) => {
      confirmation = { resolve, previousFocus: document.activeElement };
      try {
        dialog.showModal();
        $("confirmation-cancel").focus();
      } catch (_) {
        confirmation = null;
        resolve(false);
        tell("확인창을 열지 못했어요. 다시 시도해주세요.", true);
      }
    });
  }

  function cancelConfirmation() {
    if (confirmation) {
      confirmation.canceled = true;
      $("confirmation-dialog").close("cancel");
    }
  }

  async function allowDiscard() {
    if (state.saving || confirmation) return false;
    if (!hasUnsaved()) return true;
    return confirmAction({
      title: "작성 중인 내용을 버릴까요?",
      message: "저장하지 않은 내용이 있어요. 이동하면 변경 내용이 사라져요.",
      acceptLabel: "버리고 이동",
    });
  }

  function releaseImages() {
    state.imageVersion += 1;
    for (const url of state.imageURLs) URL.revokeObjectURL(url);
    state.imageURLs.clear();
  }

  function releaseImagesIn(container) {
    for (const image of container.querySelectorAll("img")) {
      if (state.imageURLs.has(image.src)) {
        URL.revokeObjectURL(image.src);
        state.imageURLs.delete(image.src);
      }
    }
  }

  function coverElement(entity, large = false) {
    const placeholder = node("span", large ? "cover-preview cover-placeholder" : "cover-thumb cover-placeholder", "古");
    placeholder.setAttribute("aria-hidden", "true");
    if (entity.cover_url && state.accessToken) {
      const version = state.imageVersion;
      request(entity.cover_url, { blob: true }).then((blob) => {
        if (version !== state.imageVersion || !placeholder.isConnected || !state.accessToken) return;
        const url = URL.createObjectURL(blob);
        state.imageURLs.add(url);
        const image = node("img", large ? "cover-preview" : "cover-thumb");
        image.src = url;
        image.alt = large ? "등록한 표지" : "";
        placeholder.replaceWith(image);
      }).catch(() => { /* A missing cover keeps the neutral placeholder. */ });
    }
    return placeholder;
  }

  function renderBreadcrumbs() {
    const holder = $("breadcrumbs");
    holder.replaceChildren();
    const crumbs = [{ title: "서재", depth: 0 }, ...state.trail.map((item, index) => ({ title: item.title, depth: index + 1 }))];
    crumbs.forEach((crumb, index) => {
      if (index) { const separator = node("span", "", "／"); separator.setAttribute("aria-hidden", "true"); holder.append(separator); }
      if (index === crumbs.length - 1) {
        const text = node("span", "", crumb.title);
        text.setAttribute("aria-current", "page");
        holder.append(text);
      } else holder.append(button(crumb.title, () => navigate(state.trail.slice(0, crumb.depth)), ""));
    });
  }

  async function navigate(trail, { discard = true, successMessage = "" } = {}) {
    if (discard && !(await allowDiscard())) return;
    const previousTrail = state.trail;
    state.trail = trail;
    state.data = null;
    const version = ++state.requestVersion;
    state.loading = true;
    $("refresh-button").disabled = true;
    $("catalog-panel").setAttribute("aria-busy", "true");
    const loading = node("div", "loading-state");
    loading.append(node("span", "loading-dot"), node("span", "", "콘텐츠를 불러오고 있어요…"));
    $("catalog-panel").replaceChildren(loading);
    renderBreadcrumbs();
    if (discard) renderEditorEmpty();
    tell("");
    try {
      const data = await request(detailPath(current()));
      if (version !== state.requestVersion) return;
      const selected = current();
      if ((!selected && !Array.isArray(data?.items)) || (selected && !data?.[singular[selected.kind]]?.id)) throw new APIError(0, "invalid_response");
      state.data = data;
      if (selected) selected.title = data[singular[selected.kind]].title;
      renderCatalog();
      if (successMessage) tell(successMessage);
    } catch (error) {
      if (version !== state.requestVersion || !state.accessToken) return;
      $("catalog-panel").replaceChildren();
      const empty = node("div", "empty-state");
      empty.append(node("p", "", errorText(error)), button("다시 불러오기", () => navigate(trail, { discard: false })));
      if (trail.length) empty.append(button("서재로 돌아가기", () => navigate([]), "button button-quiet"));
      $("catalog-panel").append(empty);
      state.data = null;
      if (!trail.length && previousTrail.length) renderBreadcrumbs();
    } finally {
      if (version === state.requestVersion || !state.accessToken) {
        state.loading = false;
        $("refresh-button").disabled = false;
        $("catalog-panel").setAttribute("aria-busy", "false");
      }
    }
  }

  function statusBadges(entity) {
    const holder = node("div", "item-meta");
    holder.append(node("span", entity.is_published ? "badge badge-public" : "badge", entity.is_published ? "공개" : "비공개"));
    holder.append(node("span", "badge", entity.is_ready ? "읽기 가능" : "준비 중"));
    holder.append(node("span", "", `순서 ${entity.sort_order}`));
    return holder;
  }

  function openItem(kind, record) {
    navigate([...state.trail, { kind, id: record.id, title: record.title }]);
  }

  function renderSection(kind, items, title, hint) {
    const section = node("section", "catalog-section");
    const heading = node("div", "section-heading");
    const headingTitle = node("h2", "", title);
    headingTitle.append(node("span", "section-count", items.length));
    heading.append(headingTitle, button(`+ ${labels[kind]} 추가`, () => editEntity(kind), "button button-small"));
    section.append(heading);
    if (!items.length) {
      const empty = node("div", "empty-state");
      empty.append(node("div", "empty-symbol", "＋"), node("p", "", hint));
      section.append(empty);
      return section;
    }
    const list = node("div", "catalog-list");
    list.setAttribute("role", "list");
    for (const item of items) {
      const row = node("article", "catalog-row");
      row.setAttribute("role", "listitem");
      if (kind === "books" || kind === "works") row.append(coverElement(item));
      const main = node("div", "row-main");
      const opener = button(item.title, () => openItem(kind, item), "item-open");
      opener.setAttribute("aria-label", `${item.title}, ${kind === "bites" ? "본문" : "내용"} 열기`);
      main.append(opener);
      if (item.description) main.append(node("p", "item-description", item.description));
      main.append(statusBadges(item));
      const actions = node("div", "row-actions");
      const edit = button("수정", () => editEntity(kind, item), "button button-small");
      edit.setAttribute("aria-label", `${item.title} 수정`);
      const toggle = button(item.is_published ? "비공개로" : "공개하기", () => togglePublication(kind, item), "button button-quiet");
      toggle.setAttribute("aria-label", `${item.title} ${item.is_published ? "비공개로 전환" : "공개"}`);
      actions.append(edit, toggle);
      row.append(main, actions);
      list.append(row);
    }
    section.append(list);
    return section;
  }

  function renderCatalog() {
    releaseImages();
    if (state.editor?.record && $("cover-preview")) $("cover-preview").replaceChildren(coverElement(state.editor.record, true));
    renderBreadcrumbs();
    const panel = $("catalog-panel");
    panel.replaceChildren();
    const entity = currentEntity();
    const selected = current();
    const heading = node("div", "catalog-heading");
    const text = node("div");
    text.append(node("p", "eyebrow", selected ? labels[selected.kind] : "LIBRARY"), node("h1", "", entity?.title || "우리의 고전 서재"));
    text.append(node("p", "", entity?.description || (selected ? "등록한 내용을 확인하고 차근차근 채워보세요." : "책을 등록하고, 독자에게 전할 내용을 채워보세요.")));
    if (entity) text.append(statusBadges(entity));
    heading.append(text);
    if (entity) heading.append(button("수정", () => editEntity(selected.kind, entity), "button button-small"));
    panel.append(heading);
    const data = state.data;
    if (!selected) panel.append(renderSection("books", data.items, "책 목록", "아직 등록한 책이 없어요. 첫 책을 추가해보세요."));
    if (selected?.kind === "books") {
      panel.append(renderSection("works", data.works || [], "내부 작품", "대학·중용처럼 책 안에 여러 작품이 있다면 추가하세요."));
      panel.append(renderSection("chapters", data.chapters || [], "책에 바로 속한 장", "내부 작품 구분이 없는 책은 여기에 장을 추가하세요."));
    }
    if (selected?.kind === "works") panel.append(renderSection("chapters", data.chapters || [], "장 목록", "이 작품의 첫 장을 추가해보세요."));
    if (selected?.kind === "chapters") panel.append(renderSection("bites", data.bites || [], "한입 목록", "이 장에서 읽을 첫 한입을 추가해보세요."));
    if (selected?.kind === "bites") {
      for (const [key, title] of [["original", "원문"], ["translation", "번역"], ["commentary", "해설"]]) {
        const preview = node("section", "reading-preview");
        preview.append(node("h2", "", title), node("p", entity[key] ? "" : "muted", entity[key] || "아직 입력한 내용이 없어요."));
        panel.append(preview);
      }
    }
  }

  function renderEditorEmpty() {
    state.editor = null;
    state.editorBaseline = "";
    const holder = node("div", "editor-empty");
    holder.append(node("p", "eyebrow", "작은 북라운지의 편집실"), node("h2", "", "한 권에서 한 문장까지"), node("p", "", "목록의 ‘수정’을 누르거나 새 콘텐츠를 추가하면 이곳에서 편집할 수 있어요."), node("p", "field-hint", "공개한 콘텐츠는 앱이 다시 조회할 때 반영돼요. 상위 책·작품·장이 비공개이면 그 안의 내용도 독자에게 보이지 않아요."));
    releaseImagesIn($("editor-panel"));
    $("editor-panel").replaceChildren(holder);
  }

  function inputField(form, name, label, value, { textarea = false, required = false, maxLength, type = "text", hint = "" } = {}) {
    const holder = node("div", "field");
    const caption = node("label", "", label);
    caption.htmlFor = `field-${name}`;
    const input = node(textarea ? "textarea" : "input", textarea && ["original", "translation", "commentary"].includes(name) ? "content-input" : "");
    input.id = `field-${name}`;
    input.name = name;
    if (!textarea) input.type = type;
    input.value = value ?? "";
    input.required = required;
    if (maxLength) input.maxLength = maxLength;
    if (type === "number") { input.min = "-2147483648"; input.max = "2147483647"; input.step = "1"; }
    holder.append(caption, input);
    if (hint) {
      const description = node("p", "field-hint", hint);
      description.id = `hint-${name}`;
      input.setAttribute("aria-describedby", description.id);
      holder.append(description);
    }
    form.append(holder);
    return input;
  }

  function parentFor(kind, record) {
    if (record) {
      if (kind === "works") return { book_id: record.book_id };
      if (kind === "chapters") return { book_id: record.book_id, work_id: record.work_id || null };
      if (kind === "bites") return { chapter_id: record.chapter_id };
      return {};
    }
    const selected = current();
    const entity = currentEntity();
    if (kind === "works") return { book_id: selected.id };
    if (kind === "chapters") return { book_id: selected.kind === "books" ? selected.id : entity.book_id, work_id: selected.kind === "works" ? selected.id : null };
    if (kind === "bites") return { chapter_id: selected.id };
    return {};
  }

  function nextOrder(kind) {
    const values = (!current() ? state.data?.items : state.data?.[kind]) || [];
    return values.length ? Math.min(2147483647, Math.max(...values.map((item) => item.sort_order)) + 10) : 0;
  }

  async function editEntity(kind, record = null, { force = false } = {}) {
    if (!force && !(await allowDiscard())) return;
    if (state.loading || state.saving) return;
    tell("");
    if (record && kind === "bites" && record.original === undefined) {
      const version = state.requestVersion;
      state.loading = true;
      try {
        const response = await request(`/admin/api/bites/${encodeURIComponent(record.id)}`);
        if (version !== state.requestVersion) return;
        record = response.bite;
      } catch (error) {
        tell(errorText(error), true);
        return;
      } finally { state.loading = false; }
    }
    state.editor = { kind, record, parent: parentFor(kind, record) };
    const panel = $("editor-panel");
    releaseImagesIn(panel);
    panel.replaceChildren();
    const header = node("div", "editor-heading");
    const heading = node("div");
    heading.append(node("h2", "", `${labels[kind]} ${record ? "수정" : "추가"}`), node("p", "", record ? "변경한 뒤 저장해주세요." : "새 콘텐츠는 비공개로 시작해요."));
    const close = button("닫기", async () => { if (await allowDiscard()) renderEditorEmpty(); }, "button button-quiet button-small");
    header.append(heading, close);
    const form = node("form", "editor-form");
    form.id = "editor-form";
    inputField(form, "title", "제목", record?.title || "", { required: true, maxLength: 200 });
    if (kind === "books" || kind === "works") inputField(form, "description", "소개", record?.description || "", { textarea: true, maxLength: 10000, hint: "책이나 작품을 소개하는 짧은 설명을 적어주세요." });
    if (kind === "bites") {
      inputField(form, "original", "원문", record?.original || "", { textarea: true, maxLength: 100000 });
      inputField(form, "translation", "번역", record?.translation || "", { textarea: true, maxLength: 100000 });
      inputField(form, "commentary", "해설", record?.commentary || "", { textarea: true, maxLength: 100000 });
      form.append(node("p", "field-hint", "게시할 권리와 검수를 확인한 내용을 입력하세요. 본문이 모두 비어 있으면 앱에 준비 중으로 표시돼요."));
      form.append(node("hr", "form-divider"));
    }
    inputField(form, "sort_order", "노출 순서", record?.sort_order ?? nextOrder(kind), { type: "number", required: true, hint: "작은 숫자가 먼저 나와요. 같은 숫자에서는 서버의 기본 순서를 따라요." });
    const publish = node("div", "checkbox-field");
    const checkbox = node("input");
    checkbox.type = "checkbox";
    checkbox.id = "field-is_published";
    checkbox.name = "is_published";
    checkbox.checked = record?.is_published || false;
    const label = node("label", "", "독자에게 공개");
    label.htmlFor = checkbox.id;
    label.append(node("span", "checkbox-description", "상위 콘텐츠도 공개되어 있어야 앱에 보여요."));
    publish.append(checkbox, label);
    form.append(publish);
    const error = node("p", "message");
    error.id = "editor-message";
    error.setAttribute("role", "alert");
    error.hidden = true;
    form.append(error);
    const actions = node("div", "editor-actions");
    const save = node("button", "button button-primary", record ? "변경 저장" : `${labels[kind]} 추가`);
    save.id = "save-button";
    save.type = "submit";
    actions.append(save, button("취소", async () => { if (await allowDiscard()) renderEditorEmpty(); }, "button"));
    form.append(actions);
    const status = node("p", "form-status", "");
    status.id = "form-status";
    status.setAttribute("aria-live", "polite");
    form.append(status);
    form.addEventListener("submit", saveEntity);
    form.addEventListener("input", () => { $("form-status").textContent = hasUnsaved() ? "저장하지 않은 변경 사항이 있어요." : ""; });
    panel.append(header, form);
    if (kind === "books" || kind === "works") renderCoverEditor(panel, record);
    state.editorBaseline = formSnapshot();
    $("field-title").focus({ preventScroll: true });
    if (window.matchMedia("(max-width: 800px)").matches) panel.scrollIntoView({ behavior: "auto", block: "start" });
  }

  function writePayload(kind, record) {
    const payload = { title: record.title, sort_order: record.sort_order, is_published: record.is_published, ...parentFor(kind, record) };
    if (kind === "books" || kind === "works") payload.description = record.description || "";
    if (kind === "bites") for (const field of ["original", "translation", "commentary"]) payload[field] = record[field] || "";
    return payload;
  }

  function setSaving(value) {
    state.saving = value;
    $("editor-panel").setAttribute("aria-busy", String(value));
    for (const control of $("editor-panel").querySelectorAll("button,input,textarea")) control.disabled = value;
    for (const control of $("catalog-panel").querySelectorAll("button")) control.disabled = value;
    $("refresh-button").disabled = value;
    $("logout-button").disabled = value;
  }

  async function saveEntity(event) {
    event.preventDefault();
    if (!state.editor || state.saving) return;
    const { kind, record, parent } = state.editor;
    const payload = { ...parent, title: $("field-title").value.trim(), sort_order: Number($("field-sort_order").value), is_published: $("field-is_published").checked };
    if (!payload.title) { $("field-title").setCustomValidity("제목을 입력해주세요."); $("field-title").reportValidity(); $("field-title").addEventListener("input", () => $("field-title").setCustomValidity(""), { once: true }); return; }
    if (kind === "books" || kind === "works") payload.description = $("field-description").value;
    if (kind === "bites") for (const field of ["original", "translation", "commentary"]) payload[field] = $(`field-${field}`).value;
    setMessage($("editor-message"), "");
    setSaving(true);
    $("save-button").textContent = "저장 중…";
    try {
      const response = await request(`/admin/api/${kind}${record ? `/${encodeURIComponent(record.id)}` : ""}`, { method: record ? "PUT" : "POST", body: payload });
      const saved = response?.[singular[kind]];
      if (!saved?.id) throw new APIError(0, "invalid_response", record ? "PUT" : "POST");
      state.editorBaseline = formSnapshot();
      await navigate(state.trail, { discard: false, successMessage: `${labels[kind]} 내용을 저장했어요.` });
      setSaving(false);
      await editEntity(kind, saved, { force: true });
      tell(`${labels[kind]} 내용을 저장했어요. 공개된 내용은 앱이 다시 조회할 때 반영돼요.`);
    } catch (error) {
      setMessage($("editor-message"), errorText(error), true);
    } finally {
      setSaving(false);
      if ($("save-button")) $("save-button").textContent = state.editor?.record ? "변경 저장" : `${labels[kind]} 추가`;
    }
  }

  async function togglePublication(kind, record) {
    if (state.saving || state.loading || !(await allowDiscard())) return;
    const action = record.is_published ? "비공개로 바꾸면 하위 내용도 독자에게 보이지 않아요. 변경할까요?" : "상위 콘텐츠가 공개되어 있으면 앱에 표시돼요. 공개할까요?";
    if (!(await confirmAction({ title: record.is_published ? "비공개로 바꿀까요?" : "독자에게 공개할까요?", message: `${record.title}\n${action}`, acceptLabel: record.is_published ? "비공개로 변경" : "공개하기" }))) return;
    if (state.saving || state.loading || !state.accessToken) return;
    setSaving(true);
    tell("");
    try {
      let full = record;
      if (kind === "bites" && record.original === undefined) full = (await request(`/admin/api/bites/${encodeURIComponent(record.id)}`)).bite;
      await request(`/admin/api/${kind}/${encodeURIComponent(record.id)}`, { method: "PUT", body: { ...writePayload(kind, full), is_published: !record.is_published } });
      renderEditorEmpty();
      await navigate(state.trail, { discard: false, successMessage: "공개 설정을 변경했어요." });
    } catch (error) { tell(errorText(error), true); }
    finally { setSaving(false); }
  }

  function renderCoverEditor(panel, record) {
    const cover = node("section", "cover-editor");
    cover.append(node("h3", "", "표지 이미지"));
    if (!record) {
      cover.append(node("p", "field-hint", "먼저 내용을 저장한 다음 표지를 등록할 수 있어요."));
      panel.append(cover);
      return;
    }
    const preview = node("div");
    preview.id = "cover-preview";
    preview.append(coverElement(record, true));
    cover.append(preview);
    const label = node("label", "field-hint", "새 표지 선택");
    label.htmlFor = "cover-file";
    const file = node("input");
    file.type = "file";
    file.id = "cover-file";
    file.accept = "image/png,image/jpeg,image/webp";
    file.setAttribute("aria-describedby", "cover-hint");
    const hint = node("p", "field-hint", "PNG, JPEG, WebP · 최대 5 MiB. 표지는 별도로 저장돼요.");
    hint.id = "cover-hint";
    const upload = button("표지 업로드", uploadCover, "button button-small");
    upload.id = "cover-upload";
    const message = node("p", "message");
    message.id = "cover-message";
    message.setAttribute("role", "alert");
    message.hidden = true;
    cover.append(label, file, hint, upload, message);
    panel.append(cover);
  }

  async function uploadCover() {
    if (state.saving || !state.editor?.record) return;
    const file = $("cover-file").files[0];
    if (!file) { setMessage($("cover-message"), "업로드할 표지를 선택해주세요.", true); return; }
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) { setMessage($("cover-message"), "PNG, JPEG, WebP 형식의 이미지를 선택해주세요.", true); return; }
    if (file.size > 5 * 1024 * 1024) { setMessage($("cover-message"), "표지는 5 MiB 이하의 파일을 선택해주세요.", true); return; }
    const { kind, record } = state.editor;
    const body = new FormData();
    body.append("file", file);
    setMessage($("cover-message"), "");
    setSaving(true);
    $("cover-upload").textContent = "업로드 중…";
    try {
      const response = await request(`/admin/api/${kind}/${encodeURIComponent(record.id)}/cover`, { method: "POST", body });
      if (typeof response?.cover_url !== "string") throw new APIError(0, "invalid_response", "POST");
      record.cover_url = response.cover_url;
      $("cover-file").value = "";
      releaseImagesIn($("cover-preview"));
      $("cover-preview").replaceChildren(coverElement(record, true));
      setMessage($("cover-message"), "표지를 저장했어요. 목록에는 새로고침 후 반영돼요.");
    } catch (error) { setMessage($("cover-message"), errorText(error), true); }
    finally { setSaving(false); $("cover-upload").textContent = "표지 업로드"; }
  }

  async function signOut() {
    if (state.saving || !(await allowDiscard())) return;
    const refresh = state.refreshToken;
    state.accessToken = null;
    state.refreshToken = null;
    state.user = null;
    state.sessionExpired = false;
    state.requestVersion += 1;
    state.trail = [];
    state.data = null;
    releaseImages();
    renderEditorEmpty();
    $("catalog-panel").replaceChildren();
    $("session-actions").hidden = true;
    $("workspace").hidden = true;
    $("login-panel").hidden = false;
    $("password").value = "";
    setMessage($("login-message"), "로그아웃했어요.");
    $("email").focus();
    if (refresh) {
      try { await request("/auth/logout", { method: "POST", authenticated: false, body: { refresh_token: refresh } }); }
      catch (_) { setMessage($("login-message"), "이 창에서는 로그아웃했어요. 연결 문제로 서버의 세션 해제를 확인하지 못했어요.", true); }
    }
  }

  $("confirmation-cancel").addEventListener("click", cancelConfirmation);
  $("confirmation-accept").addEventListener("click", () => {
    if (confirmation) $("confirmation-dialog").close("confirm");
  });
  $("confirmation-dialog").addEventListener("cancel", (event) => {
    event.preventDefault();
    cancelConfirmation();
  });
  $("confirmation-dialog").addEventListener("close", () => {
    if (!confirmation) return;
    const pending = confirmation;
    confirmation = null;
    if (pending.previousFocus?.isConnected && !state.sessionExpired) pending.previousFocus.focus({ preventScroll: true });
    pending.resolve(!pending.canceled && $("confirmation-dialog").returnValue === "confirm");
  });
  $("login-form").addEventListener("submit", signIn);
  $("refresh-button").addEventListener("click", () => navigate(state.trail));
  $("logout-button").addEventListener("click", signOut);
  window.addEventListener("beforeunload", (event) => {
    if (hasUnsaved() || state.saving) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("pagehide", () => { releaseImages(); state.accessToken = null; state.refreshToken = null; });
  window.addEventListener("pageshow", (event) => { if (event.persisted) expireSession(); });
  loadConfiguration().catch((error) => setMessage($("login-message"), errorText(error), true));
})();

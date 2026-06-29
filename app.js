"use strict";

/* ============ 定数 ============ */
const SCOPES = [
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/drive.file",
].join(" ");
const PHOTO_FOLDER_NAME = "ContactsPWA_Photos";
const PERSON_FIELDS = "names,nicknames,emailAddresses,phoneNumbers,addresses,organizations,biographies,photos,metadata,birthdays,memberships";

/* ============ 状態 ============ */
let tokenClient = null;
let accessToken = null;
let contacts = [];           // People API の person オブジェクト配列
let photoFolderId = null;    // Drive 上の写真フォルダID
let photoMeta = {};          // contactId -> { faceFileId, cardFileId }
let contactGroups = [];      // { resourceName, name } の配列
let objectUrls = [];         // 解放用
let current = null;          // 編集中の連絡先 { person, isNew, pendingFace, pendingCard, clearFace, clearCard }

/* ============ DOM ============ */
const $ = (id) => document.getElementById(id);
const els = {
  authBtn: $("authBtn"), syncBtn: $("syncBtn"), search: $("search"),
  welcome: $("welcome"), listView: $("listView"), contactList: $("contactList"),
  addBtn: $("addBtn"), editor: $("editor"), backBtn: $("backBtn"),
  saveBtn: $("saveBtn"), deleteBtn: $("deleteBtn"), editorTitle: $("editorTitle"),
  facePhoto: $("facePhoto"), cardPhoto: $("cardPhoto"),
  faceInput: $("faceInput"), cardInput: $("cardInput"),
  fName: $("fName"), fOrg: $("fOrg"), fTitle: $("fTitle"),
  fNickname: $("fNickname"),
  phoneRows: $("phoneRows"), emailRows: $("emailRows"), addressRows: $("addressRows"),
  fBirthday: $("fBirthday"), birthdayInfo: $("birthdayInfo"),
  groupCheckboxes: $("groupCheckboxes"), newGroupName: $("newGroupName"), addGroupBtn: $("addGroupBtn"),
  fNote: $("fNote"),
  toast: $("toast"), spinner: $("spinner"),
};

/* ============ ユーティリティ ============ */
function toast(msg) {
  els.toast.textContent = msg; els.toast.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (els.toast.hidden = true), 2600);
}
function busy(on) { els.spinner.hidden = !on; }

/* ============ 誕生日計算 ============ */
function calcAge(y, m, d) {
  const today = new Date();
  let age = today.getFullYear() - y;
  const mNow = today.getMonth() + 1, dNow = today.getDate();
  if (mNow < m || (mNow === m && dNow < d)) age--;
  return age;
}
function getZodiac(m, d) {
  const signs = [
    [1,20,"山羊座"],[2,19,"水瓶座"],[3,21,"魚座"],[4,20,"牡羊座"],
    [5,21,"牡牛座"],[6,22,"双子座"],[7,23,"蟹座"],[8,23,"獅子座"],
    [9,23,"乙女座"],[10,23,"天秤座"],[11,22,"蠍座"],[12,22,"射手座"],[12,31,"山羊座"],
  ];
  for (const [em, ed, name] of signs) { if (m < em || (m === em && d <= ed)) return name; }
  return "山羊座";
}
function getEto(y) {
  const eto = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
  return eto[(y - 4) % 12] + "年";
}
function birthdayInfo(y, m, d) {
  const parts = [];
  if (y) { parts.push(calcAge(y, m, d) + "歳"); parts.push(getEto(y)); }
  parts.push(getZodiac(m, d));
  return parts.join(" / ");
}

/* ============ 複数行入力 (電話・メール) ============ */
const PHONE_TYPES = [
  ["mobile", "携帯"],
  ["work", "会社"],
  ["home", "自宅"],
  ["main", "メイン"],
  ["workFax", "FAX(会社)"],
  ["homeFax", "FAX(自宅)"],
  ["other", "その他"],
];
const EMAIL_TYPES = [
  ["home", "個人"],
  ["work", "会社"],
  ["other", "その他"],
];
const ADDRESS_TYPES = [
  ["home", "自宅"],
  ["work", "会社"],
  ["other", "その他"],
];

function addRow(container, kind, value, type) {
  const typesMap = { phone: PHONE_TYPES, email: EMAIL_TYPES, address: ADDRESS_TYPES };
  const types = typesMap[kind];
  const row = document.createElement("div");
  row.className = "multi-row" + (kind === "address" ? " multi-row-address" : "");
  const sel = document.createElement("select");
  for (const [val, label] of types) {
    const opt = document.createElement("option");
    opt.value = val; opt.textContent = label;
    if (val === type) opt.selected = true;
    sel.appendChild(opt);
  }
  let inp;
  if (kind === "address") {
    inp = document.createElement("textarea");
    inp.rows = 2; inp.value = value || "";
  } else {
    inp = document.createElement("input");
    inp.type = kind === "phone" ? "tel" : "email";
    inp.value = value || "";
  }
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "remove-row"; btn.textContent = "✕";
  btn.addEventListener("click", () => row.remove());
  row.appendChild(sel); row.appendChild(inp); row.appendChild(btn);
  container.appendChild(row);
}

function getRows(container) {
  return Array.from(container.querySelectorAll(".multi-row")).map((row) => ({
    value: (row.querySelector("input") || row.querySelector("textarea")).value.trim(),
    type: row.querySelector("select").value,
  })).filter((r) => r.value);
}
function safeId(resourceName) { return (resourceName || "").replace(/[^a-zA-Z0-9]/g, "_"); }

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: "Bearer " + accessToken, ...(opts.headers || {}) },
  });
  if (res.status === 401) { reAuth(); throw new Error("認証切れ。再ログインしてください。"); }
  if (!res.ok) {
    let detail = ""; try { detail = (await res.json()).error?.message || ""; } catch {}
    throw new Error(`API ${res.status}: ${detail}`);
  }
  return res.status === 204 ? null : res.json();
}

/* ============ 認証 ============ */
function initAuth() {
  if (!window.google || !google.accounts) { setTimeout(initAuth, 200); return; }
  if (!CONFIG.CLIENT_ID || CONFIG.CLIENT_ID.startsWith("PASTE_")) {
    toast("config.js にクライアントIDを設定してください");
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: SCOPES,
    callback: (resp) => {
      if (resp.error) { toast("ログイン失敗: " + resp.error); return; }
      accessToken = resp.access_token;
      onSignedIn();
    },
  });
}
function signIn() { tokenClient.requestAccessToken({ prompt: contacts.length ? "" : "consent" }); }
function reAuth() { accessToken = null; tokenClient && tokenClient.requestAccessToken({ prompt: "" }); }

async function onSignedIn() {
  els.authBtn.textContent = "更新";
  els.search.hidden = false; els.syncBtn.hidden = false; els.addBtn.hidden = false;
  await loadAll();
}

/* ============ データ読み込み ============ */
async function loadAll() {
  busy(true);
  try {
    await ensurePhotoFolder();
    await Promise.all([loadContacts(), loadPhotoMeta(), loadGroups()]);
    renderList();
    els.welcome.hidden = true; els.listView.hidden = false;
  } catch (e) { toast(e.message); console.error(e); }
  finally { busy(false); }
}

async function loadContacts() {
  contacts = [];
  let pageToken = "";
  do {
    const url = new URL("https://people.googleapis.com/v1/people/me/connections");
    url.searchParams.set("personFields", PERSON_FIELDS);
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("sortOrder", "FIRST_NAME_ASCENDING");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await api(url.toString());
    contacts.push(...(data.connections || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
}

async function ensurePhotoFolder() {
  const q = encodeURIComponent(
    `name='${PHOTO_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const data = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
  if (data.files && data.files.length) { photoFolderId = data.files[0].id; return; }
  const created = await api("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: PHOTO_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
  });
  photoFolderId = created.id;
}

async function loadPhotoMeta() {
  photoMeta = {};
  if (!photoFolderId) return;
  const q = encodeURIComponent(`'${photoFolderId}' in parents and trashed=false`);
  let pageToken = "";
  do {
    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name)&pageSize=1000` +
      (pageToken ? `&pageToken=${pageToken}` : "");
    const data = await api(url);
    for (const f of data.files || []) {
      // 命名規則: {contactId}__face.jpg / {contactId}__card.jpg
      const m = f.name.match(/^(.+)__(face|card)\./);
      if (!m) continue;
      const id = m[1];
      (photoMeta[id] ||= {})[m[2] === "face" ? "faceFileId" : "cardFileId"] = f.id;
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
}

async function loadGroups() {
  contactGroups = [];
  const data = await api("https://people.googleapis.com/v1/contactGroups?pageSize=100&groupFields=name,groupType");
  for (const g of data.contactGroups || []) {
    if (g.groupType === "USER_CONTACT_GROUP") {
      contactGroups.push({ resourceName: g.resourceName, name: g.name });
    }
  }
  contactGroups.sort((a, b) => a.name.localeCompare(b.name));
}

function getPersonGroups(person) {
  if (!person?.memberships) return [];
  return person.memberships
    .filter((m) => m.contactGroupMembership)
    .map((m) => m.contactGroupMembership.contactGroupResourceName)
    .filter((rn) => rn !== "contactGroups/myContacts");
}

async function driveImageUrl(fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: "Bearer " + accessToken },
  });
  if (!res.ok) return null;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob); objectUrls.push(url); return url;
}

/* ============ 一覧表示 ============ */
function personInfo(p) {
  const displayName = p.names?.[0]?.displayName;
  const nickname = p.nicknames?.[0]?.value;
  const org = p.organizations?.[0];
  const orgLine = [org?.name, org?.title].filter(Boolean).join(" · ");
  const name = displayName || org?.name || p.emailAddresses?.[0]?.value
    || p.phoneNumbers?.[0]?.value || "（名称未設定）";
  let sub = "";
  if (displayName) {
    const parts = [nickname, orgLine].filter(Boolean);
    sub = parts.join(" / ") || p.emailAddresses?.[0]?.value || p.phoneNumbers?.[0]?.value || "";
  } else if (org?.name) sub = org?.title || p.emailAddresses?.[0]?.value || p.phoneNumbers?.[0]?.value || "";
  else sub = p.phoneNumbers?.[0]?.value || "";
  return { name, sub };
}

function renderList() {
  for (const u of objectUrls) URL.revokeObjectURL(u); objectUrls = [];
  const term = (els.search.value || "").trim().toLowerCase();
  const frag = document.createDocumentFragment();
  let shown = 0;

  for (const p of contacts) {
    const { name, sub } = personInfo(p);
    if (term && !(name + " " + sub).toLowerCase().includes(term)) continue;
    shown++;
    const id = safeId(p.resourceName);
    const meta = photoMeta[id] || {};
    const row = document.createElement("div");
    row.className = "contact-row";
    row.innerHTML = `
      <div class="avatar" data-av="${id}">${name.charAt(0)}</div>
      <div class="contact-meta">
        <div class="name"></div><div class="sub"></div>
      </div>
      ${meta.cardFileId ? '<span class="badge-card">名刺</span>' : ""}`;
    row.querySelector(".name").textContent = name;
    row.querySelector(".sub").textContent = sub;
    row.addEventListener("click", () => openEditor(p));
    frag.appendChild(row);

  }

  els.contactList.innerHTML = "";
  if (!shown) {
    els.contactList.innerHTML = `<p style="text-align:center;color:var(--muted);margin-top:40px">該当する連絡先がありません</p>`;
    return;
  }
  els.contactList.appendChild(frag);

  // frag をDOMに追加した後でアバター画像を設定
  for (const p of contacts) {
    const id = safeId(p.resourceName);
    if (!els.contactList.querySelector(`[data-av="${id}"]`)) continue;
    const meta = photoMeta[id] || {};
    const photoUrl = p.photos?.find((ph) => !ph.default)?.url;
    if (meta.faceFileId) {
      driveImageUrl(meta.faceFileId).then((u) => u && setAvatar(id, u));
    } else if (photoUrl) {
      setAvatar(id, photoUrl);
    }
  }
}
function setAvatar(id, url) {
  const el = els.contactList.querySelector(`[data-av="${id}"]`);
  if (el) el.innerHTML = `<img src="${url}" alt="">`;
}

/* ============ 編集 ============ */
async function openEditor(person) {
  current = { person, isNew: !person, pendingFace: null, pendingCard: null, clearFace: false, clearCard: false };
  const p = person || {};
  els.editorTitle.textContent = person ? "連絡先を編集" : "新規連絡先";
  els.deleteBtn.hidden = !person;

  els.fName.value = p.names?.[0]?.displayName || "";
  els.fNickname.value = p.nicknames?.[0]?.value || "";
  els.fOrg.value = p.organizations?.[0]?.name || "";
  els.fTitle.value = p.organizations?.[0]?.title || "";
  els.fNote.value = p.biographies?.[0]?.value || "";

  // 電話番号を複数行で表示
  els.phoneRows.innerHTML = "";
  const phones = p.phoneNumbers || [];
  if (phones.length) {
    for (const ph of phones) addRow(els.phoneRows, "phone", ph.value, ph.type || "mobile");
  } else {
    addRow(els.phoneRows, "phone", "", "mobile");
  }

  // メールを複数行で表示
  els.emailRows.innerHTML = "";
  const emails = p.emailAddresses || [];
  if (emails.length) {
    for (const em of emails) addRow(els.emailRows, "email", em.value, em.type || "home");
  } else {
    addRow(els.emailRows, "email", "", "home");
  }

  // 住所を複数行で表示
  els.addressRows.innerHTML = "";
  const addrs = p.addresses || [];
  if (addrs.length) {
    for (const a of addrs) addRow(els.addressRows, "address", a.formattedValue || a.streetAddress || "", a.type || "home");
  }

  // 誕生日
  const bd = p.birthdays?.[0]?.date;
  if (bd && bd.month && bd.day) {
    const y = bd.year || "";
    const dateStr = y
      ? `${y}-${String(bd.month).padStart(2,"0")}-${String(bd.day).padStart(2,"0")}`
      : `2000-${String(bd.month).padStart(2,"0")}-${String(bd.day).padStart(2,"0")}`;
    els.fBirthday.value = dateStr;
    els.birthdayInfo.textContent = birthdayInfo(bd.year, bd.month, bd.day);
  } else {
    els.fBirthday.value = "";
    els.birthdayInfo.textContent = "";
  }

  // グループ
  const memberOf = getPersonGroups(p);
  els.groupCheckboxes.innerHTML = "";
  for (const g of contactGroups) {
    const chip = document.createElement("div");
    chip.className = "group-chip";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.value = g.resourceName;
    cb.id = "grp_" + g.resourceName; cb.checked = memberOf.includes(g.resourceName);
    const lbl = document.createElement("label");
    lbl.htmlFor = cb.id; lbl.textContent = g.name;
    chip.appendChild(cb); chip.appendChild(lbl);
    els.groupCheckboxes.appendChild(chip);
  }
  els.newGroupName.value = "";

  resetPhotoBox("face"); resetPhotoBox("card");
  els.editor.hidden = false;

  if (person) {
    const meta = photoMeta[safeId(person.resourceName)] || {};
    if (meta.faceFileId) driveImageUrl(meta.faceFileId).then((u) => u && showPhoto("face", u));
    else {
      const g = person.photos?.find((ph) => !ph.default)?.url;
      if (g) showPhoto("face", g);
    }
    if (meta.cardFileId) driveImageUrl(meta.cardFileId).then((u) => u && showPhoto("card", u));
  }
}

function boxFor(kind) { return kind === "face" ? els.facePhoto : els.cardPhoto; }
function showPhoto(kind, url) {
  const box = boxFor(kind);
  const img = box.querySelector("img");
  img.src = url; img.hidden = false;
  box.querySelector(".photo-placeholder").hidden = true;
  box.parentElement.querySelector("[data-clear]").hidden = false;
}
function resetPhotoBox(kind) {
  const box = boxFor(kind);
  const img = box.querySelector("img");
  img.removeAttribute("src"); img.hidden = true;
  box.querySelector(".photo-placeholder").hidden = false;
  box.parentElement.querySelector("[data-clear]").hidden = true;
}

function onPickPhoto(kind, file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    showPhoto(kind, reader.result);
    if (kind === "face") { current.pendingFace = file; current.clearFace = false; }
    else { current.pendingCard = file; current.clearCard = false; }
  };
  reader.readAsDataURL(file);
}

function clearPhoto(kind) {
  resetPhotoBox(kind);
  if (kind === "face") { current.pendingFace = null; current.clearFace = true; }
  else { current.pendingCard = null; current.clearCard = true; }
}

/* ============ 保存 ============ */
function buildPersonBody() {
  const name = els.fName.value.trim();
  const nickname = els.fNickname.value.trim();
  const phoneEntries = getRows(els.phoneRows).map((r) => ({ value: r.value, type: r.type }));
  const emailEntries = getRows(els.emailRows).map((r) => ({ value: r.value, type: r.type }));
  const addressEntries = getRows(els.addressRows).map((r) => ({ formattedValue: r.value, type: r.type }));
  const bdVal = els.fBirthday.value;
  let birthdays = [];
  if (bdVal) {
    const [y, m, d] = bdVal.split("-").map(Number);
    birthdays = [{ date: { year: y, month: m, day: d } }];
  }
  const body = {
    names: name ? [{ unstructuredName: name }] : [],
    nicknames: nickname ? [{ value: nickname }] : [],
    organizations: (els.fOrg.value || els.fTitle.value)
      ? [{ name: els.fOrg.value.trim(), title: els.fTitle.value.trim() }] : [],
    phoneNumbers: phoneEntries,
    emailAddresses: emailEntries,
    addresses: addressEntries,
    birthdays,
    biographies: els.fNote.value.trim() ? [{ value: els.fNote.value.trim(), contentType: "TEXT_PLAIN" }] : [],
  };
  return body;
}

async function fileToBase64(file) {
  const dataUrl = await new Promise((res) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file);
  });
  return dataUrl.split(",")[1];
}

async function uploadDrivePhoto(contactId, kind, file, existingFileId) {
  const name = `${contactId}__${kind}.jpg`;
  const meta = { name, parents: existingFileId ? undefined : [photoFolderId] };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }));
  form.append("file", file);
  const base = "https://www.googleapis.com/upload/drive/v3/files";
  const url = existingFileId
    ? `${base}/${existingFileId}?uploadType=multipart`
    : `${base}?uploadType=multipart`;
  const data = await api(url, { method: existingFileId ? "PATCH" : "POST", body: form });
  return data.id;
}

async function deleteDrivePhoto(fileId) {
  await api(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: "DELETE" });
}

async function save() {
  if (!els.fName.value.trim()) { toast("名前を入力してください"); return; }
  busy(true);
  try {
    let person = current.person;
    const body = buildPersonBody();

    if (current.isNew) {
      person = await api(
        `https://people.googleapis.com/v1/people:createContact?personFields=${PERSON_FIELDS}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      );
    } else {
      const mask = "names,nicknames,organizations,phoneNumbers,emailAddresses,addresses,birthdays,biographies";
      person = await api(
        `https://people.googleapis.com/v1/${person.resourceName}:updateContact` +
        `?updatePersonFields=${mask}&personFields=${PERSON_FIELDS}`,
        {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, etag: person.etag }),
        }
      );
    }

    const cid = safeId(person.resourceName);
    const meta = (photoMeta[cid] ||= {});

    // 顔写真: Google連絡先写真として登録（iPhoneに同期）＋ Driveにも保存
    if (current.pendingFace) {
      const b64 = await fileToBase64(current.pendingFace);
      await api(`https://people.googleapis.com/v1/${person.resourceName}:updateContactPhoto`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photoBytes: b64, personFields: PERSON_FIELDS }),
      });
      meta.faceFileId = await uploadDrivePhoto(cid, "face", current.pendingFace, meta.faceFileId);
    } else if (current.clearFace) {
      await api(`https://people.googleapis.com/v1/${person.resourceName}:deleteContactPhoto?personFields=${PERSON_FIELDS}`,
        { method: "DELETE" });
      if (meta.faceFileId) { await deleteDrivePhoto(meta.faceFileId).catch(() => {}); delete meta.faceFileId; }
    }

    // 名刺写真: Driveのみ
    if (current.pendingCard) {
      meta.cardFileId = await uploadDrivePhoto(cid, "card", current.pendingCard, meta.cardFileId);
    } else if (current.clearCard && meta.cardFileId) {
      await deleteDrivePhoto(meta.cardFileId).catch(() => {});
      delete meta.cardFileId;
    }

    // グループの追加・削除
    const selectedGroups = Array.from(els.groupCheckboxes.querySelectorAll("input:checked")).map((cb) => cb.value);
    const prevGroups = getPersonGroups(person);
    const toAdd = selectedGroups.filter((g) => !prevGroups.includes(g));
    const toRemove = prevGroups.filter((g) => !selectedGroups.includes(g));
    for (const grn of toAdd) {
      await api(`https://people.googleapis.com/v1/${grn}/members:modify`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceNamesToAdd: [person.resourceName] }),
      }).catch(() => {});
    }
    for (const grn of toRemove) {
      await api(`https://people.googleapis.com/v1/${grn}/members:modify`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceNamesToRemove: [person.resourceName] }),
      }).catch(() => {});
    }

    toast("保存しました");
    closeEditor();
    await loadAll();
  } catch (e) { toast(e.message); console.error(e); }
  finally { busy(false); }
}

async function removeContact() {
  if (!current.person || !confirm("この連絡先を削除しますか？")) return;
  busy(true);
  try {
    const cid = safeId(current.person.resourceName);
    await api(`https://people.googleapis.com/v1/${current.person.resourceName}:deleteContact`, { method: "DELETE" });
    const meta = photoMeta[cid] || {};
    if (meta.faceFileId) await deleteDrivePhoto(meta.faceFileId).catch(() => {});
    if (meta.cardFileId) await deleteDrivePhoto(meta.cardFileId).catch(() => {});
    toast("削除しました");
    closeEditor();
    await loadAll();
  } catch (e) { toast(e.message); console.error(e); }
  finally { busy(false); }
}

function closeEditor() { els.editor.hidden = true; current = null; }

/* ============ イベント ============ */
els.authBtn.addEventListener("click", () => (accessToken ? loadAll() : signIn()));
els.syncBtn.addEventListener("click", loadAll);
els.addBtn.addEventListener("click", () => openEditor(null));
els.backBtn.addEventListener("click", closeEditor);
els.saveBtn.addEventListener("click", save);
els.deleteBtn.addEventListener("click", removeContact);
els.search.addEventListener("input", renderList);
els.facePhoto.addEventListener("click", () => els.faceInput.click());
els.cardPhoto.addEventListener("click", () => els.cardInput.click());
els.faceInput.addEventListener("change", (e) => onPickPhoto("face", e.target.files[0]));
els.cardInput.addEventListener("change", (e) => onPickPhoto("card", e.target.files[0]));
document.querySelectorAll("[data-clear]").forEach((b) =>
  b.addEventListener("click", () => clearPhoto(b.dataset.clear)));
els.fBirthday.addEventListener("change", () => {
  const v = els.fBirthday.value;
  if (!v) { els.birthdayInfo.textContent = ""; return; }
  const [y, m, d] = v.split("-").map(Number);
  els.birthdayInfo.textContent = birthdayInfo(y, m, d);
});
document.querySelectorAll("[data-add]").forEach((b) =>
  b.addEventListener("click", () => {
    const kind = b.dataset.add;
    const containers = { phone: els.phoneRows, email: els.emailRows, address: els.addressRows };
    const defaults = { phone: "mobile", email: "home", address: "home" };
    addRow(containers[kind], kind, "", defaults[kind]);
  }));
els.addGroupBtn.addEventListener("click", async () => {
  const name = els.newGroupName.value.trim();
  if (!name) return;
  busy(true);
  try {
    const created = await api("https://people.googleapis.com/v1/contactGroups", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactGroup: { name } }),
    });
    contactGroups.push({ resourceName: created.resourceName, name: created.name });
    contactGroups.sort((a, b) => a.name.localeCompare(b.name));
    const chip = document.createElement("div");
    chip.className = "group-chip";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.value = created.resourceName;
    cb.id = "grp_" + created.resourceName; cb.checked = true;
    const lbl = document.createElement("label");
    lbl.htmlFor = cb.id; lbl.textContent = created.name;
    chip.appendChild(cb); chip.appendChild(lbl);
    els.groupCheckboxes.appendChild(chip);
    els.newGroupName.value = "";
    toast("グループ「" + name + "」を作成しました");
  } catch (e) { toast(e.message); }
  finally { busy(false); }
});

/* ============ 起動 ============ */
initAuth();
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

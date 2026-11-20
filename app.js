/* EKHM v0.3
 * Prototype: anonymous Firebase login, private room pairing, online status, opt-in GPS sharing (repeat 30 dtk),
 * remote capture (foto/video/audio) + WebRTC live streaming + nada dering remote.
 * Model izin:
 *  - foto/video/audio/streaming: izin cukup SEKALI per HP pemberi izin, lalu tersimpan di HP itu
 *    (bisa dicabut kapan saja di panel IZIN DI HP INI). Selama kamera/mikrofon aktif selalu ada
 *    banner merah di HP itu + indikator kamera/mikrofon bawaan browser (tidak bisa disembunyikan).
 *  - nada dering: saklar opt-in di HP penerima.
 * Rules Realtime Database yang dibutuhkan (sudah sesuai project):
 *  - auth user membuat ruang baru, join sebagai member, member membaca ruangnya
 *  - devices/$uid hanya bisa ditulis oleh uid sendiri (commands/, media/, rtc/ di bawah node sendiri)
 * Jangan pakai test mode untuk data lokasi.
 */
const firebaseConfig = {
  apiKey: "AIzaSyCGGiag9QO1hT4OeeVIbnBJaPB8Wwp9y3M",
  authDomain: "ekhm-48.firebaseapp.com",
  databaseURL: "https://ekhm-48-default-rtdb.asia-southeast1.firebasedatabase.app", // tanpa spasi & tanpa slash di akhir
  projectId: "ekhm-48",
  appId: "1:199798166148:web:b34ea26a207e9826eb68d1"
};

const $ = (id) => document.getElementById(id);
const state = {
  user: null, roomId: null, roomRef: null, devicesRef: null, deviceRef: null,
  watchId: null, locTimer: null, rtdbConnected: false, pendingConnect: false,
  ring: null, ringCid: null, ringAutoStop: null, lastRingTarget: null,
  modal: null, capturing: null, recBanner: null, pendingCommands: {}, handled: {},
  rtc: null, rtcHandled: {}, liveTimeout: null, mediaUrls: {}
};

// Kode ruang, nama perangkat & preferensi izin disimpan lokal supaya
// sesi dan pairing tetap ada setelah halaman di-refresh.
const ROOM_KEY = "ekhm_room";
const NAME_KEY = "ekhm_name";
const RING_KEY = "ekhm_ring";
const PERM_PREFIX = "ekhm_perm_"; // izin tersimpan per UID HP pengirim: ekhm_perm_<uid> = nama

const EMPTY_DEVICES = '<div class="empty-state"><span>⌁</span><p>Belum ada perangkat terhubung.</p></div>';
const EMPTY_LOCATIONS = '<p class="muted">Lokasi perangkat akan tampil di sini setelah dibagikan.</p>';
const EMPTY_MEDIA = '<p class="muted">Belum ada foto/video/audio. Hasil remote capture akan tampil di sini.</p>';
const EMPTY_PERMS = '<p class="muted">Belum ada HP yang punya izin tersimpan. Permintaan pertama akan menampilkan dialog izin.</p>';
const ACTION_LABEL = { photo: "FOTO", video: "VIDEO", audio: "AUDIO", ring: "NADA DERING", ringStop: "MATIKAN BUNYI", stream: "LIVE STREAMING" };

const randomCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => chars[b % chars.length]).join("");
};
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isValidCode = (code) => /^[A-HJ-NP-Z2-9]{10}$/.test(code);
const newId = (prefix) => prefix + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36).padStart(3, "0");
const currentName = () => $("deviceName").value.trim() || "Perangkat EKHM";

// Bersihkan mime hasil MediaRecorder. blob.type sering berisi parameter codec
// (mis. "video/webm;codecs=vp8,opus") bahkan "video/x-matroska" di sebagian
// perangkat. Koma di parameter codec merusak parsing data:URL dan tipe
// x-matroska tidak dikenal semua <video>. Ini penyebab video tersimpan tapi
// tidak mau tampil. Ambil tipe dasarnya saja dan samakan ke webm/mp4.
function cleanMime(m) {
  let t = String(m || "").split(";")[0].trim().toLowerCase();
  if (t === "video/x-matroska") t = "video/webm";
  if (t === "audio/x-matroska") t = "audio/webm";
  if (!t || t === "video/unknown" || t === "audio/unknown") return "";
  return t;
}

// Izin tersimpan per HP pengirim (sekali izin, berlaku terus, bisa dicabut)
function hasPerm(uid) { return !!localStorage.getItem(PERM_PREFIX + uid); }
function grantPerm(uid, name) {
  localStorage.setItem(PERM_PREFIX + uid, name || "Perangkat");
  renderPerms();
}
function revokePerm(uid) { localStorage.removeItem(PERM_PREFIX + uid); }
function renderPerms() {
  const list = $("permList");
  if (!list) return;
  list.innerHTML = "";
  const entries = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.indexOf(PERM_PREFIX) === 0) entries.push({ uid: k.slice(PERM_PREFIX.length), name: localStorage.getItem(k) || "Perangkat" });
  }
  if (!entries.length) { list.innerHTML = EMPTY_PERMS; return; }
  entries.forEach(function (e) {
    const item = document.createElement("div");
    item.className = "location-item";
    const head = document.createElement("strong");
    head.textContent = e.name;
    const sub = document.createElement("small");
    sub.textContent = "Kamera, mikrofon & streaming diizinkan otomatis • " + e.uid.slice(0, 8);
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost";
    btn.textContent = "HAPUS IZIN";
    btn.style.marginTop = "6px";
    btn.addEventListener("click", function () {
      revokePerm(e.uid);
      renderPerms();
      toast("Izin untuk " + e.name + " dihapus. Permintaan berikutnya akan ditanyakan lagi.");
    });
    item.appendChild(head); item.appendChild(sub); item.appendChild(btn);
    list.appendChild(item);
  });
}

function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 3200);
}
function setStatus(message) { $("authStatus").textContent = message; }
function setPairStatus(message) { $("pairStatus").textContent = message; }
function setCaptureStatus(message) { $("captureStatus").textContent = message; }
function setConnection(online) {
  const top = document.querySelector(".top-status");
  top.classList.toggle("online", !!online);
  $("connectionLabel").textContent = online ? "TERHUBUNG" : "BELUM TERHUBUNG";
}
// Status topbar hanya hidup kalau login anonymous BERHASIL dan koneksi realtime
// database-nya benar-benar nyala (bukan cuma halamannya terbuka).
function refreshConnection() {
  setConnection(!!state.user && state.rtdbConnected);
}
function firebaseReady() {
  const placeholders = ["ISI_API_KEY", "ISI_PROJECT_ID", "ISI_APP_ID"];
  return !!firebaseConfig.apiKey && !!firebaseConfig.projectId && !!firebaseConfig.appId &&
    !placeholders.includes(firebaseConfig.apiKey) &&
    !placeholders.includes(firebaseConfig.projectId) &&
    !placeholders.includes(firebaseConfig.appId);
}
function enableControls(on) {
  ["createRoomBtn", "joinRoomBtn", "locationToggle", "photoBtn", "videoBtn", "audioBtn", "streamBtn", "ringBtn"].forEach(id => $(id).disabled = !on);
  $("connectBtn").disabled = on;
  $("disconnectBtn").disabled = !on;
}
function isPermissionError(err) {
  return err && (err.code === "PERMISSION_DENIED" || /permission_denied/i.test(err.message || ""));
}

// Salin teks ke clipboard, dengan fallback manual untuk konteks non-HTTPS
// (mis. halaman dibuka langsung dari file, tanpa server).
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* coba fallback */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

async function connect() {
  if (!firebaseReady()) {
    $("setupNotice").style.display = "";
    toast("Isi konfigurasi Firebase di app.js terlebih dahulu.");
    setStatus("Firebase belum dikonfigurasi.");
    return;
  }
  if (typeof firebase === "undefined") {
    toast("Library Firebase gagal dimuat. Cek koneksi internet.");
    setStatus("Library Firebase tidak termuat.");
    return;
  }
  if (state.user) return; // sudah terhubung
  $("connectBtn").disabled = true; // cegah klik ganda saat proses login
  state.pendingConnect = true;
  setStatus("Menghubungkan ke Firebase…");
  try {
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    await firebase.auth().signInAnonymously();
    // Lanjutan ada di handleAuthState (dipanggil otomatis oleh Firebase)
  } catch (err) {
    state.pendingConnect = false;
    enableControls(false);
    console.error(err);
    setStatus("Gagal terhubung: " + err.message);
    toast("Gagal login Firebase. Pastikan Anonymous sign-in aktif dan domain sudah diizinkan.");
  }
}

// Dipanggil Firebase setiap kali status login berubah,
// termasuk memulihkan sesi lama saat halaman di-refresh.
async function handleAuthState(user) {
  const fresh = !!user && state.pendingConnect;
  state.pendingConnect = false;
  state.user = user || null;
  enableControls(!!user);
  refreshConnection();
  if (!user) return;
  $("setupNotice").style.display = "none";
  if (fresh) {
    setStatus("Terhubung sebagai perangkat: " + user.uid.slice(0, 8));
    setPairStatus("Buat ruang atau gabung pakai kode dari HP utama.");
    toast("Perangkat berhasil terhubung.");
  } else {
    setStatus("Sesi dipulihkan: " + user.uid.slice(0, 8));
  }
  // Pulihkan pairing lama kalau ada (halaman di-refresh / koneksi browser sempat putus)
  const savedRoom = localStorage.getItem(ROOM_KEY);
  if (savedRoom && isValidCode(savedRoom) && !state.roomId) {
    try {
      await enterRoom(savedRoom);
      $("roomCode").textContent = savedRoom;
      $("copyCodeBtn").disabled = false;
      setPairStatus("Ruang dipulihkan otomatis: " + savedRoom);
    } catch (err) {
      console.warn(err);
      localStorage.removeItem(ROOM_KEY);
      setPairStatus("Ruang lama tidak bisa dipulihkan. Buat atau gabung ruang lagi.");
    }
  } else if (!state.roomId) {
    setPairStatus("Buat ruang atau gabung pakai kode dari HP utama.");
  }
}

async function updateDeviceName() {
  if (!state.user || !state.deviceRef) return;
  const name = currentName();
  localStorage.setItem(NAME_KEY, name);
  try {
    await state.deviceRef.update({
      name: name,
      uid: state.user.uid,
      online: true,
      lastSeen: firebase.database.ServerValue.TIMESTAMP
    });
  } catch (err) { console.error(err); toast("Gagal menyimpan nama perangkat."); }
}

async function createRoom() {
  if (!state.user) return;
  try {
    const code = randomCode();
    const ref = firebase.database().ref("rooms/" + code);
    await ref.set({
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      createdBy: state.user.uid,
      members: { [state.user.uid]: true }
    });
    await enterRoom(code);
    $("roomCode").textContent = code;
    $("copyCodeBtn").disabled = false;
    setPairStatus("Ruang dibuat. Masukkan kode ini di HP kedua.");
    toast("Kode pairing berhasil dibuat.");
  } catch (err) {
    console.error(err);
    setPairStatus("Gagal membuat ruang: " + err.message);
    toast(isPermissionError(err) ? "Ditolak oleh Database Rules. Cek rules di Firebase." : "Gagal membuat ruang.");
  }
}

async function joinRoom() {
  if (!state.user) return;
  const code = $("joinCode").value.trim().toUpperCase();
  if (!isValidCode(code)) {
    toast("Kode harus terdiri dari 10 karakter."); return;
  }
  try {
    // Langsung daftar sebagai member. Rules hanya mengizinkan kalau ruangnya ada,
    // jadi non-member tidak perlu (dan tidak boleh) membaca ruang lebih dulu.
    // Salah ketik kode = write ditolak rules -> muncul "Kode ruang tidak ditemukan".
    await firebase.database().ref("rooms/" + code + "/members/" + state.user.uid).set(true);
    await enterRoom(code);
    $("roomCode").textContent = code;
    $("copyCodeBtn").disabled = false;
    $("joinCode").value = "";
    setPairStatus("Berhasil bergabung ke ruang " + code + ".");
    toast("Pairing berhasil.");
  } catch (err) {
    console.error(err);
    if (isPermissionError(err)) {
      setPairStatus("Kode ruang tidak ditemukan.");
      toast("Kode ruang tidak ditemukan.");
    } else {
      setPairStatus("Gagal bergabung: " + err.message);
    }
  }
}

async function enterRoom(code) {
  // Lepas listener ruang sebelumnya kalau ada
  if (state.devicesRef) state.devicesRef.off();
  if (state.deviceRef) { try { await state.deviceRef.onDisconnect().cancel(); } catch (e) { /* abaikan */ } }

  state.roomId = code;
  state.roomRef = firebase.database().ref("rooms/" + code);
  state.devicesRef = state.roomRef.child("devices");
  state.deviceRef = state.devicesRef.child(state.user.uid);

  await state.roomRef.child("members/" + state.user.uid).set(true);
  await state.deviceRef.onDisconnect().update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP });
  await updateDeviceName();
  localStorage.setItem(ROOM_KEY, code);
  setCaptureStatus("Pilih perangkat tujuan, lalu kirim perintah.");
  state.devicesRef.on("value", renderDevices, err => {
    console.error(err);
    toast("Gagal membaca daftar perangkat.");
  });
}

function renderDevices(snapshot) {
  const list = $("deviceList"); list.innerHTML = "";
  if (!snapshot.exists()) {
    list.innerHTML = EMPTY_DEVICES;
    $("locationList").innerHTML = EMPTY_LOCATIONS;
    $("mediaList").innerHTML = EMPTY_MEDIA;
    updateTargetSelect(snapshot);
    return;
  }
  const myUid = state.user && state.user.uid;
  snapshot.forEach(child => {
    const d = child.val() || {};
    const isSelf = child.key === myUid;
    const hasLoc = typeof d.lat === "number" && typeof d.lng === "number";
    const item = document.createElement("div");
    item.className = "device-item";
    item.innerHTML = `<div><div class="device-name">${escapeHtml(d.name || "Perangkat")}${isSelf ? " (HP ini)" : ""}</div><div class="device-meta">${hasLoc ? "Lokasi tersedia" : "Lokasi belum dibagikan"}</div></div><span class="online-pill">${d.online ? "ONLINE" : "OFFLINE"}</span>`;
    list.appendChild(item);
  });
  renderLocations(snapshot);
  renderMedia(snapshot);
  updateTargetSelect(snapshot);
  scanCommands(snapshot);
}

function renderLocations(snapshot) {
  const list = $("locationList"); list.innerHTML = "";
  const myUid = state.user && state.user.uid;
  let found = false;
  snapshot.forEach(child => {
    const d = child.val() || {};
    if (typeof d.lat !== "number" || typeof d.lng !== "number") return;
    found = true;
    const item = document.createElement("div"); item.className = "location-item";
    const name = escapeHtml(d.name || "Perangkat");
    const coords = `${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`;
    const mapsUrl = "https://www.google.com/maps?q=" + encodeURIComponent(d.lat + "," + d.lng);
    item.innerHTML = `<strong>${name}${child.key === myUid ? " (HP ini)" : ""}</strong><small>${coords}<br><a href="${mapsUrl}" target="_blank" rel="noopener">Buka di Google Maps ↗</a></small>`;
    list.appendChild(item);
  });
  if (!found) list.innerHTML = '<p class="muted">Belum ada perangkat yang membagikan lokasi.</p>';
}

function updateTargetSelect(snapshot) {
  const sel = $("targetDevice");
  const prev = sel.value;
  const myUid = state.user && state.user.uid;
  sel.innerHTML = "";
  const others = [];
  snapshot.forEach(child => {
    if (myUid && child.key !== myUid) {
      const d = child.val() || {};
      others.push({ uid: child.key, name: d.name || "Perangkat", online: !!d.online });
    }
  });
  if (!others.length) {
    sel.appendChild(new Option(myUid ? "Belum ada HP lain di ruang ini" : "Hubungkan dan pairing dulu…", ""));
  } else {
    others.forEach(o => sel.appendChild(new Option(o.name + (o.online ? " • ONLINE" : " • OFFLINE"), o.uid)));
  }
  if (prev && Array.prototype.some.call(sel.options, op => op.value === prev)) sel.value = prev;
}

// Decode base64 -> Blob -> blob: URL. Jauh lebih andal daripada data:URL untuk
// media: tidak kena batas parsing (koma di codec, ukuran) di browser mana pun.
function b64ToBlobUrl(key, data, mime) {
  if (state.mediaUrls[key]) return state.mediaUrls[key];
  try {
    let d = String(data);
    // Data lama (v0.2) kadang masih menyisipkan awalan data-URL; buang kalau ada
    if (d.indexOf(";base64,") !== -1) d = d.slice(d.lastIndexOf(";base64,") + 8);
    d = d.replace(/\s+/g, "");
    const bin = atob(d);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    state.mediaUrls[key] = url;
    return url;
  } catch (e) { console.warn("decode media gagal:", e); return ""; }
}

function renderMedia(snapshot) {
  const list = $("mediaList"); list.innerHTML = "";
  const items = [];
  snapshot.forEach(child => {
    const d = child.val() || {};
    const media = d.media || {};
    Object.keys(media).forEach(k => {
      const v = media[k] || {};
      if (typeof v.data !== "string" || !v.data) return;
      items.push({ uid: child.key, key: k, name: d.name || "Perangkat", type: v.type, mime: v.mime, data: v.data, ts: v.ts || 0 });
    });
  });
  // Cabut blob URL yang tidak dipakai lagi biar memori tidak menumpuk
  const keep = {};
  items.forEach(v => { keep[v.uid + "/" + v.key] = 1; });
  Object.keys(state.mediaUrls).forEach(k => {
    if (!keep[k]) { try { URL.revokeObjectURL(state.mediaUrls[k]); } catch (e) { /* abaikan */ } delete state.mediaUrls[k]; }
  });
  items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (!items.length) { list.innerHTML = EMPTY_MEDIA; return; }
  items.slice(0, 12).forEach(v => {
    const item = document.createElement("div");
    item.className = "location-item";
    const label = ACTION_LABEL[v.type] || "MEDIA";
    const when = v.ts ? new Date(v.ts).toLocaleTimeString("id-ID") : "";
    const mime = cleanMime(v.mime) || (v.type === "audio" ? "audio/webm" : v.type === "video" ? "video/webm" : "image/jpeg");
    let body = "";
    if (v.type === "photo") {
      body = '<img src="data:image/jpeg;base64,' + v.data + '" alt="foto remote" style="max-width:100%;border-radius:8px;margin-top:8px">';
    } else if (v.type === "video") {
      const u = b64ToBlobUrl(v.uid + "/" + v.key, v.data, mime);
      body = u
        ? '<video controls playsinline preload="metadata" src="' + u + '" style="width:100%;max-height:300px;border-radius:8px;margin-top:8px;background:#000"></video>'
        : '<p class="muted">Video tidak bisa dibuka di browser ini.</p>';
    } else {
      const u = b64ToBlobUrl(v.uid + "/" + v.key, v.data, mime);
      body = u
        ? '<audio controls preload="metadata" src="' + u + '" style="width:100%;margin-top:8px"></audio>'
        : '<p class="muted">Audio tidak bisa dibuka di browser ini.</p>';
    }
    item.innerHTML = '<strong>' + label + ' — ' + escapeHtml(v.name) + '</strong><small>' + when + '</small>' + body;
    list.appendChild(item);
  });
}

/* ============================================================
 * COMMANDS: antar-perangkat diperintah lewat node devices/$uid/commands.
 * Semua tulis hanya di node device SENDIRI (aman dengan rules).
 * ============================================================ */
function sendCommand(targetUid, action, fireAndForget) {
  if (!state.user || !state.devicesRef) { toast("Hubungkan dan pairing perangkat terlebih dahulu."); return; }
  if (!targetUid || targetUid === (state.user && state.user.uid)) { toast("Pilih HP lain sebagai tujuan."); return; }
  const cid = newId("c");
  if (!fireAndForget) state.pendingCommands[cid] = { action: action, target: targetUid, sentAt: Date.now(), lastStatus: null };
  if (action === "ring") {
    state.lastRingTarget = targetUid;
    setCaptureStatus("Meminta membunyikan HP tujuan… (menunggu persetujuan)");
  } else {
    setCaptureStatus("Permintaan " + ACTION_LABEL[action] + " dikirim… menunggu persetujuan di HP tujuan.");
  }
  state.devicesRef.child(state.user.uid + "/commands/" + cid).set({
    target: targetUid, action: action, fromName: currentName(), ts: firebase.database.ServerValue.TIMESTAMP
  }).catch(err => {
    console.error(err);
    delete state.pendingCommands[cid];
    setCaptureStatus("Gagal mengirim perintah.");
    toast(isPermissionError(err) ? "Ditolak Database Rules." : "Gagal mengirim perintah.");
  });
  return cid;
}

// Periksa perintah yang belum dijawab > 90 detik -> anggap target tidak merespons.
// Perintah yang sudah dapat balasan (accepted/dst) tidak di-timeout, tunggu status terminalnya.
function tickPending() {
  const myUid = state.user && state.user.uid;
  if (!myUid || !state.devicesRef) return;
  Object.keys(state.pendingCommands).forEach(cid => {
    const p = state.pendingCommands[cid];
    if (p.lastStatus) return; // sedang berjalan di HP tujuan, tunggu status akhir
    if (Date.now() - p.sentAt < 90000) return;
    delete state.pendingCommands[cid];
    state.devicesRef.child(myUid + "/commands/" + cid).remove().catch(function () {});
    if (p.action === "ring") $("ringStopBtn").hidden = true;
    setCaptureStatus("Tidak ada respons dari HP tujuan (offline / tidak merespons).");
    toast("Tidak ada respons dari HP tujuan.");
  });
}

function setCommandStatus(cid, status, extra) {
  if (!state.user || !state.devicesRef || !cid) return;
  const data = { status: status, ts: firebase.database.ServerValue.TIMESTAMP };
  if (extra) Object.keys(extra).forEach(k => { data[k] = extra[k]; });
  state.devicesRef.child(state.user.uid + "/commands/" + cid).update(data).catch(function (e) { console.warn(e); });
}

// Status balasan dari HP target untuk perintah yang kita kirim
function onCommandStatus(p, status, fromName) {
  const label = ACTION_LABEL[p.action] || p.action;
  if (p.action === "ring") {
    if (status === "accepted") {
      $("ringStopBtn").hidden = false;
      setCaptureStatus("Bunyi aktif di " + fromName + " — tekan MATIKAN BUNYI untuk berhenti.");
      toast("HP " + fromName + " mulai berbunyi.");
    } else if (status === "denied") {
      $("ringStopBtn").hidden = true;
      setCaptureStatus("Nada dering remote nonaktif di HP tujuan.");
      toast(fromName + " menolak (nada dering remote tidak aktif di sana).");
    } else if (status === "stopped") {
      $("ringStopBtn").hidden = true;
      setCaptureStatus("Bunyi dimatikan di HP tujuan.");
      toast(fromName + " mematikan bunyi.");
    }
    return;
  }
  if (status === "accepted") {
    setCaptureStatus(fromName + " menyetujui — sedang mengambil " + label + "…");
  } else if (status === "done") {
    setCaptureStatus(label + " diterima dari " + fromName + ". Tampil di galeri bawah.");
    toast(label + " berhasil diterima.");
  } else if (status === "denied") {
    setCaptureStatus(fromName + " menolak permintaan " + label + ".");
    toast(fromName + " menolak permintaan " + label + ".");
  } else {
    setCaptureStatus("Pengambilan " + label + " gagal di " + fromName + ".");
    toast("Pengambilan " + label + " gagal di " + fromName + ".");
  }
}

// Status balasan dianggap selesai pada status-satus ini
const TERMINAL_STATUS = { done: 1, denied: 1, cancelled: 1, error: 1, stopped: 1 };

// Scan snapshot devices: cari balasan status + permintaan masuk untuk HP ini
function scanCommands(snapshot) {
  const myUid = state.user && state.user.uid;
  if (!myUid || !state.devicesRef) return;
  const now = Date.now();
  snapshot.forEach(child => {
    const d = child.val() || {};
    const cmds = d.commands || {};
    Object.keys(cmds).forEach(cid => {
      const c = cmds[cid] || {};
      // 1) Balasan status untuk perintah yang kita kirim (cermin status ada di node pengirim status).
      //    Status perantara (mis. accepted) tidak menghapus entry, tunggu status terminal.
      if (state.pendingCommands[cid] && c.status && c.status !== state.pendingCommands[cid].lastStatus) {
        const p = state.pendingCommands[cid];
        p.lastStatus = c.status;
        onCommandStatus(p, c.status, d.name || "perangkat");
        if (TERMINAL_STATUS[c.status]) {
          delete state.pendingCommands[cid];
          state.devicesRef.child(myUid + "/commands/" + cid).remove().catch(function () {});
        }
        return;
      }
      // 2) Bereskan perintah lama milik sendiri (> 15 menit)
      if (child.key === myUid && typeof c.ts === "number" && now - c.ts > 900000) {
        state.devicesRef.child(myUid + "/commands/" + cid).remove().catch(function () {});
        return;
      }
      // 3) Permintaan masuk ditulis di node PENGIRIM, alamatnya kita
      if (child.key !== myUid && c.target === myUid && !c.status && !state.handled[cid]) {
        state.handled[cid] = true;
        if (typeof c.ts === "number" && now - c.ts < 120000) {
          handleIncoming(cid, c, child.key, d.name || "Perangkat");
        }
      }
    });
    // 4) Pesan signaling WebRTC (rtc/out di node pengirim, alamatnya kita)
    if (child.key !== myUid) {
      const out = (d.rtc && d.rtc.out) || {};
      Object.keys(out).forEach(mid => {
        const m = out[mid] || {};
        if (!m.target || m.target !== myUid || state.rtcHandled[mid]) return;
        state.rtcHandled[mid] = 1;
        if (Object.keys(state.rtcHandled).length > 400) state.rtcHandled = {};
        if (typeof m.ts !== "number" || now - m.ts > 120000) return; // pesan kedaluwarsa
        handleRtcMessage(m, child.key, d.name || "Perangkat");
      });
    } else {
      // 5) Bereskan pesan signaling milik sendiri yang sudah kedaluwarsa
      const ownOut = (d.rtc && d.rtc.out) || {};
      Object.keys(ownOut).forEach(mid => {
        const m = ownOut[mid] || {};
        if (typeof m.ts === "number" && now - m.ts > 120000) {
          state.devicesRef.child(myUid + "/rtc/out/" + mid).remove().catch(function () {});
        }
      });
    }
  });
}

function handleIncoming(cid, cmd, fromUid, fromName) {
  if (cmd.action === "ringStop") { stopRing(false); return; }
  if (cmd.action === "ring") {
    if (!$("ringToggle").checked) {
      setCommandStatus(cid, "denied");
      toast(fromName + " mencoba membunyikan HP ini — nada dering remote sedang nonaktif.");
      return;
    }
    setCommandStatus(cid, "accepted");
    startRing(fromName, cid);
    return;
  }
  // foto/video/audio: kamera/mikrofon sibuk kalau sedang streaming atau merekam
  if (state.rtc || state.capturing) {
    setCommandStatus(cid, "denied");
    toast("HP ini sedang streaming/merekam — permintaan " + fromName + " ditolak.");
    return;
  }
  // Izin cukup sekali: kalau HP pengirim pernah diizinkan, jalankan langsung.
  if (hasPerm(fromUid)) {
    toast("Auto-diizinkan (izin tersimpan): " + (ACTION_LABEL[cmd.action] || cmd.action) + " dari " + fromName);
    runCapture(cmd.action, fromName, fromUid, cid);
    return;
  }
  if (state.modal) {
    setCommandStatus(cid, "denied");
    toast("Ada dialog lain yang terbuka — permintaan " + fromName + " ditolak.");
    return;
  }
  showApprovalModal(cid, cmd, fromName, function (accepted) {
    if (accepted) grantPerm(fromUid, fromName);
    setCommandStatus(cid, accepted ? "accepted" : "denied");
    if (!accepted) { toast("Permintaan " + (ACTION_LABEL[cmd.action] || cmd.action) + " dari " + fromName + " ditolak."); return; }
    runCapture(cmd.action, fromName, fromUid, cid);
  });
}

/* ============================================================
 * DIALOG PERSETUJUAN (selalu tampil di HP target)
 * ============================================================ */
function showApprovalModal(cid, cmd, fromName, cb) {
  const label = ACTION_LABEL[cmd.action] || cmd.action;
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;z-index:200;padding:16px";
  const card = document.createElement("div");
  card.className = "panel";
  card.style.cssText = "max-width:420px;width:100%;margin:0";
  card.innerHTML =
    '<span class="mini-label">PERMINTAAN BARU</span>' +
    '<h3 style="margin:8px 0 4px">' + escapeHtml(fromName) + ' meminta ' + label + ' dari HP ini.</h3>' +
    '<p class="muted" style="margin-bottom:4px">Kalau diizinkan, izin TERSIMPAN untuk HP ini — permintaan berikutnya dari sana dijalankan otomatis tanpa dialog. Selama kamera/mikrofon aktif selalu ada banner merah + indikator bawaan browser, dan izin bisa dicabut kapan saja di panel IZIN DI HP INI.</p>';
  const row = document.createElement("div");
  row.className = "button-row";
  const ok = document.createElement("button");
  ok.className = "btn btn-primary";
  ok.textContent = "IZINKAN";
  const no = document.createElement("button");
  no.className = "btn btn-ghost";
  no.textContent = "TOLAK";
  row.appendChild(ok); row.appendChild(no);
  card.appendChild(row); wrap.appendChild(card); document.body.appendChild(wrap);
  state.modal = { wrap: wrap, timer: null };
  const done = function (accepted) {
    if (!state.modal || state.modal.wrap !== wrap) return;
    clearTimeout(state.modal.timer);
    wrap.remove();
    state.modal = null;
    cb(accepted);
  };
  ok.addEventListener("click", function () { done(true); });
  no.addEventListener("click", function () { done(false); });
  state.modal.timer = setTimeout(function () { done(false); }, 30000); // auto-tolak kalau diabaikan
}
function hideModal() {
  if (state.modal) {
    clearTimeout(state.modal.timer);
    state.modal.wrap.remove();
    state.modal = null;
  }
}

/* ============================================================
 * CAPTURE: foto / video / audio di HP penerima (setelah disetujui)
 * ============================================================ */
function showRecBanner() {
  if (state.recBanner) return state.recBanner.textEl;
  const wrap = document.createElement("div");
  wrap.className = "notice";
  wrap.style.cssText = "position:fixed;top:12px;left:12px;right:12px;z-index:210;max-width:560px;margin:0 auto;align-items:center";
  const icon = document.createElement("div");
  icon.className = "notice-icon";
  icon.style.background = "#ff5a5a";
  icon.textContent = "●";
  const textEl = document.createElement("div");
  textEl.style.flex = "1";
  const stop = document.createElement("button");
  stop.className = "btn btn-ghost";
  stop.textContent = "BATAL";
  stop.style.marginLeft = "8px";
  stop.addEventListener("click", function () { cancelCapture(); });
  wrap.appendChild(icon); wrap.appendChild(textEl); wrap.appendChild(stop);
  document.body.appendChild(wrap);
  state.recBanner = { wrap: wrap, textEl: textEl };
  return textEl;
}
function setRecBanner(text) { showRecBanner().textContent = text; }
function hideRecBanner() {
  if (state.recBanner) { state.recBanner.wrap.remove(); state.recBanner = null; }
}
function cancelCapture() {
  if (state.capturing && state.capturing.cancel) state.capturing.cancel();
}

function pickRecorderMime(candidates) {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  for (let i = 0; i < candidates.length; i++) {
    try { if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i]; } catch (e) { /* lanjut */ }
  }
  return "";
}

// Encode blob ke base64 murni. PENTING: jangan pakai readAsDataURL + split(","),
// karena blob MediaRecorder sering bertipe "video/webm;codecs=vp8,opus" — koma di
// dalam mime membuat split memotong di tempat salah dan data rekaman HILANG
// (hanya tersisa "opus;base64"). Inilah penyebab video lama tersimpan tapi tidak
// bisa ditampilkan. Sekarang dibaca sebagai ArrayBuffer lalu di-encode manual.
function blobToBase64(blob) {
  return new Promise(function (resolve, reject) {
    const r = new FileReader();
    r.onload = function () {
      try {
        const bytes = new Uint8Array(r.result);
        let bin = "";
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        resolve(btoa(bin));
      } catch (e) { reject(e); }
    };
    r.onerror = function () { reject(new Error("Gagal membaca hasil rekaman.")); };
    r.readAsArrayBuffer(blob);
  });
}

function capturePhoto() {
  return new Promise(function (resolve, reject) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return reject(new Error("Browser tidak mendukung kamera (butuh HTTPS)."));
    setRecBanner("MENYIAPKAN KAMERA…");
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then(async function (stream) {
        const video = document.createElement("video");
        video.srcObject = stream; video.muted = true; video.playsInline = true;
        const cleanup = function () { stream.getTracks().forEach(function (t) { t.stop(); }); };
        try {
          await new Promise(function (res, rej) {
            video.onloadedmetadata = res;
            video.onerror = function () { rej(new Error("Gagal membuka kamera.")); };
          });
          await video.play();
          await new Promise(function (r) { setTimeout(r, 400); }); // tunggu fokus/exposure sesaat
          setRecBanner("MENGAMBIL FOTO…");
          const sizes = [1280, 960, 720, 560];
          let data = null, w = 0, h = 0;
          for (let i = 0; i < sizes.length; i++) {
            const scale = Math.min(1, sizes[i] / Math.max(video.videoWidth || 640, video.videoHeight || 480));
            const canvas = document.createElement("canvas");
            canvas.width = Math.round((video.videoWidth || 640) * scale);
            canvas.height = Math.round((video.videoHeight || 480) * scale);
            canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
            data = canvas.toDataURL("image/jpeg", 0.62).split(",")[1];
            w = canvas.width; h = canvas.height;
            if (data.length <= 1300000) break; // pas dengan batas ukuran database
          }
          cleanup();
          if (!data) throw new Error("Gagal memproses foto.");
          resolve({ type: "photo", mime: "image/jpeg", data: data, w: w, h: h });
        } catch (err) { cleanup(); reject(err); }
      })
      .catch(reject);
  });
}

function captureAudio(durationMs) {
  return new Promise(function (resolve, reject) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return reject(new Error("Browser tidak mendukung mikrofon (butuh HTTPS)."));
    if (typeof MediaRecorder === "undefined") return reject(new Error("Browser tidak mendukung MediaRecorder."));
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (stream) {
        const mime = pickRecorderMime(["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]);
        const opts = mime ? { mimeType: mime, audioBitsPerSecond: 28000 } : undefined;
        let rec;
        try { rec = new MediaRecorder(stream, opts); } catch (e) { rec = new MediaRecorder(stream); }
        const chunks = [];
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          clearInterval(state.capturing && state.capturing.countdown);
          if (state.capturing && state.capturing.cancelled) return resolve({ cancelled: true });
          const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
          blobToBase64(blob).then(function (data) {
            resolve({ type: "audio", mime: blob.type || "audio/webm", data: data, dur: Math.round(durationMs / 1000) });
          }).catch(reject);
        };
        rec.onerror = function (e) { stream.getTracks().forEach(function (t) { t.stop(); }); reject(new Error("Perekaman gagal.")); };
        state.capturing.cancel = function () {
          state.capturing.cancelled = true;
          if (rec.state !== "inactive") rec.stop();
        };
        rec.start();
        const end = Date.now() + durationMs;
        const tick = function () {
          const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
          setRecBanner("REKAM AUDIO AKTIF — " + left + " dtk lagi");
        };
        tick();
        state.capturing.countdown = setInterval(tick, 1000);
        setTimeout(function () { if (rec.state !== "inactive") rec.stop(); }, durationMs);
      })
      .catch(reject);
  });
}

function captureVideo(durationMs) {
  return new Promise(function (resolve, reject) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return reject(new Error("Browser tidak mendukung kamera (butuh HTTPS)."));
    if (typeof MediaRecorder === "undefined") return reject(new Error("Browser tidak mendukung MediaRecorder."));
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 640 }, height: { ideal: 480 } }, audio: true })
      .then(function (stream) {
        const mime = pickRecorderMime(["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm", "video/mp4"]);
        const opts = mime ? { mimeType: mime, videoBitsPerSecond: 250000, audioBitsPerSecond: 28000 } : undefined;
        let rec;
        try { rec = new MediaRecorder(stream, opts); } catch (e) { rec = new MediaRecorder(stream); }
        const chunks = [];
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          clearInterval(state.capturing && state.capturing.countdown);
          if (state.capturing && state.capturing.cancelled) return resolve({ cancelled: true });
          const blob = new Blob(chunks, { type: rec.mimeType || "video/webm" });
          blobToBase64(blob).then(function (data) {
            resolve({ type: "video", mime: blob.type || "video/webm", data: data, dur: Math.round(durationMs / 1000) });
          }).catch(reject);
        };
        rec.onerror = function (e) { stream.getTracks().forEach(function (t) { t.stop(); }); reject(new Error("Perekaman gagal.")); };
        state.capturing.cancel = function () {
          state.capturing.cancelled = true;
          if (rec.state !== "inactive") rec.stop();
        };
        rec.start();
        const end = Date.now() + durationMs;
        const tick = function () {
          const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
          setRecBanner("REKAM VIDEO AKTIF — " + left + " dtk lagi");
        };
        tick();
        state.capturing.countdown = setInterval(tick, 1000);
        setTimeout(function () { if (rec.state !== "inactive") rec.stop(); }, durationMs);
      })
      .catch(reject);
  });
}

async function runCapture(action, fromName, fromUid, cid) {
  if (!state.user || !state.devicesRef) return;
  state.capturing = { action: action, cid: cid, cancel: null, cancelled: false };
  try {
    let result;
    if (action === "photo") result = await capturePhoto();
    else if (action === "video") result = await captureVideo(8000);
    else result = await captureAudio(10000);
    if (result && result.cancelled) {
      setCommandStatus(cid, "cancelled");
      toast("Pengambilan dibatalkan di HP ini.");
      return;
    }
    setRecBanner("MENGIRIM " + (ACTION_LABEL[action] || action) + "…");
    await writeMedia(result, cid, fromUid);
    setCommandStatus(cid, "done");
    toast(ACTION_LABEL[action] + " terkirim ke " + fromName + ".");
  } catch (err) {
    console.error(err);
    setCommandStatus(cid, "error");
    toast("Gagal mengambil " + (ACTION_LABEL[action] || action) + ": " + (err.message || err));
  } finally {
    state.capturing = null;
    hideRecBanner();
    pruneMedia();
  }
}

async function writeMedia(result, cid, fromUid) {
  if (!result.data || result.data.length > 1400000) throw new Error("hasil terlalu besar untuk dikirim lewat database");
  const pid = newId("m");
  await state.devicesRef.child(state.user.uid + "/media/" + pid).set({
    type: result.type, mime: cleanMime(result.mime) || null, data: result.data, dur: result.dur || null,
    w: result.w || null, h: result.h || null, ts: firebase.database.ServerValue.TIMESTAMP,
    commandId: cid || null, requestedBy: fromUid || null
  });
}

// Simpan maksimal 4 media terbaru per perangkat biar database tidak menumpuk
async function pruneMedia() {
  if (!state.user || !state.devicesRef) return;
  try {
    const ref = state.devicesRef.child(state.user.uid + "/media");
    const snap = await ref.once("value");
    const entries = [];
    snap.forEach(function (c) { entries.push({ key: c.key, ts: (c.val() && c.val().ts) || 0 }); });
    entries.sort(function (a, b) { return b.ts - a.ts; });
    for (let i = 4; i < entries.length; i++) ref.child(entries[i].key).remove().catch(function () {});
  } catch (e) { console.warn(e); }
}

/* ============================================================
 * NADA DERING REMOTE (opt-in di HP penerima, full volume browser)
 * ============================================================ */
function startRing(fromName, cid) {
  stopRing(false);
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error("AudioContext tidak didukung browser ini");
    const ctx = new Ctx();
    const master = ctx.createGain();
    master.gain.value = 1; // volume maksimum yang diizinkan browser
    master.connect(ctx.destination);
    let step = 0;
    const beep = function () {
      if (ctx.state === "suspended") ctx.resume();
      const t = ctx.currentTime;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "square";
      o.frequency.value = (step++ % 2) ? 660 : 990; // sirine dua nada
      g.gain.setValueAtTime(1.0, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + 0.52);
    };
    beep();
    const timer = setInterval(beep, 560);
    state.ring = { ctx: ctx, timer: timer };
    state.ringCid = cid || null;
    showRingBanner(fromName);
    state.ringAutoStop = setTimeout(function () { stopRing(false); toast("Nada dering dimatikan otomatis."); }, 180000); // pengaman 3 menit
  } catch (e) {
    console.error(e);
    toast("Gagal memulai nada dering: " + (e.message || e));
    if (cid) setCommandStatus(cid, "error");
  }
}

function stopRing(remoteStop) {
  if (state.ringAutoStop) { clearTimeout(state.ringAutoStop); state.ringAutoStop = null; }
  if (state.ring) {
    clearInterval(state.ring.timer);
    state.ring.ctx.close().catch(function () {});
    state.ring = null;
  }
  hideRingBanner();
  if (state.ringCid) {
    const cid = state.ringCid;
    state.ringCid = null;
    if (!remoteStop) setCommandStatus(cid, "stopped"); // beri tahu pengirim kalau dimatikan di sini
  }
}

function showRingBanner(fromName) {
  const el = document.createElement("div");
  el.className = "notice";
  el.style.cssText = "position:fixed;top:12px;left:12px;right:12px;z-index:220;max-width:560px;margin:0 auto;align-items:center";
  el.innerHTML = '<div class="notice-icon" style="background:#ff5a5a">🔔</div><div style="flex:1"><strong>BUNYI REMOTE AKTIF</strong><p>Dari ' + escapeHtml(fromName) + ' — volume penuh browser ini.</p></div>';
  const btn = document.createElement("button");
  btn.className = "btn btn-ghost";
  btn.textContent = "MATIKAN";
  btn.style.marginLeft = "8px";
  btn.addEventListener("click", function () { stopRing(false); });
  el.appendChild(btn);
  document.body.appendChild(el);
  state.ringBanner = el;
}
function hideRingBanner() {
  if (state.ringBanner) { state.ringBanner.remove(); state.ringBanner = null; }
}

// Buka izin audio browser saat pengguna mengaktifkan saklar (ada gesture),
// supaya bunyi remote nanti bisa langsung auto play.
function audioUnlock() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator(), g = ctx.createGain();
    g.gain.value = 0.0001;
    o.connect(g); g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.15);
    setTimeout(function () { ctx.close().catch(function () {}); }, 400);
  } catch (e) { /* abaikan */ }
}

/* ============================================================
 * WEBRTC LIVE STREAMING
 * Signaling lewat node devices/$uid/rtc/out (tulis di node sendiri,
 * dibaca lewat listener devices — aman dengan rules yang sekarang).
 * Viewer = yang menonton, Streamer = HP yang kamera/mikrofonnya
 * disiarkan. Butuh STUN Google; NAT simetris butuh TURN (belum ada).
 * ============================================================ */
const RTC_CFG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function rtcSend(targetUid, type, payload) {
  if (!state.user || !state.devicesRef) return;
  const id = newId("r");
  state.devicesRef.child(state.user.uid + "/rtc/out/" + id).set({
    id: id, target: targetUid, type: type, payload: payload || null, ts: firebase.database.ServerValue.TIMESTAMP
  }).catch(function (e) { console.warn("rtcSend gagal:", e); });
}

// Debug helper untuk pengujian: kondisi peer connection saat ini
function rtcDebug() {
  const r = state.rtc;
  if (!r) return null;
  return { role: r.role, peer: r.peerUid, conn: r.pc && r.pc.connectionState, ice: r.pc && r.pc.iceConnectionState };
}

function startStream(targetUid) {
  if (!state.user || !state.devicesRef) { toast("Hubungkan dan pairing perangkat terlebih dahulu."); return; }
  if (!targetUid || targetUid === state.user.uid) { toast("Pilih HP lain sebagai tujuan."); return; }
  if (typeof RTCPeerConnection === "undefined") { toast("Browser tidak mendukung WebRTC."); return; }
  if (state.capturing) { toast("Sedang merekam — tunggu selesai dulu."); return; }
  if (state.rtc) { toast("Streaming sudah aktif — hentikan dulu."); return; }
  state.rtc = { role: "viewer", peerUid: targetUid, peerName: "", pc: null, pendingIce: [] };
  $("liveVideo").style.display = "none";
  $("stopStreamBtn").hidden = false;
  $("streamStatus").textContent = "Meminta streaming ke HP tujuan…";
  if (state.liveTimeout) clearTimeout(state.liveTimeout);
  state.liveTimeout = setTimeout(function () {
    if (state.rtc && state.rtc.role === "viewer" && !state.rtc.pc) {
      endStream(false);
      $("streamStatus").textContent = "HP tujuan tidak merespons / menolak streaming.";
      toast("Tidak ada respons streaming dari HP tujuan.");
    }
  }, 30000);
  rtcSend(targetUid, "streamRequest", { fromName: currentName() });
}

// Sisi PENONTON: terima offer dari HP yang ditonton
async function onStreamOffer(fromUid, fromName, desc) {
  if (!state.rtc || state.rtc.role !== "viewer" || state.rtc.peerUid !== fromUid) return;
  try {
    state.rtc.peerName = fromName;
    $("streamStatus").textContent = "Menyambungkan WebRTC ke " + fromName + "…";
    const pc = new RTCPeerConnection(RTC_CFG);
    state.rtc.pc = pc;
    pc.ontrack = function (e) {
      const v = $("liveVideo");
      if (v.srcObject !== e.streams[0]) v.srcObject = e.streams[0];
      v.style.display = "";
      v.play().catch(function () {});
      $("streamStatus").textContent = "LIVE — streaming dari " + fromName + ".";
    };
    pc.onicecandidate = function (e) { if (e.candidate) rtcSend(fromUid, "ice", e.candidate.toJSON()); };
    pc.onconnectionstatechange = function () {
      if ((pc.connectionState === "failed" || pc.connectionState === "closed") && state.rtc && state.rtc.role === "viewer") {
        endStream(false);
        $("streamStatus").textContent = "Koneksi stream terputus.";
      }
    };
    watchIce(pc, function () {
      endStream(false);
      $("streamStatus").textContent = "Koneksi stream terputus.";
    });
    await pc.setRemoteDescription({ type: "offer", sdp: desc });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    rtcSend(fromUid, "answer", { type: answer.type, sdp: answer.sdp });
    flushIce();
  } catch (e) {
    console.error(e);
    endStream(false);
    $("streamStatus").textContent = "Gagal menyambungkan stream: " + (e.message || e);
  }
}

// Sisi yang DITONTON: siapkan kamera+mic, buat offer, kirim
async function startStreamerSession(fromUid, fromName) {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("kamera/mikrofon tidak tersedia (butuh HTTPS)");
    if (state.rtc || state.capturing) throw new Error("HP ini sedang streaming/merekam");
    $("streamStatus").textContent = "HP " + fromName + " menonton — menyiapkan kamera & mikrofon…";
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 640 }, height: { ideal: 480 } }, audio: true });
    const pc = new RTCPeerConnection(RTC_CFG);
    state.rtc = { role: "streamer", peerUid: fromUid, peerName: fromName, pc: pc, stream: stream, pendingIce: [] };
    stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });
    pc.onicecandidate = function (e) { if (e.candidate) rtcSend(fromUid, "ice", e.candidate.toJSON()); };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === "connected" && state.rtc && state.rtc.role === "streamer") {
        $("streamStatus").textContent = "LIVE — HP " + fromName + " sedang menonton.";
      }
      if (pc.connectionState === "failed" || pc.connectionState === "closed") endStream(false);
    };
    watchIce(pc, function () {
      endStream(true);
      $("streamStatus").textContent = "Koneksi ke penonton terputus.";
      toast("Streaming berhenti — penonton terputus.");
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    rtcSend(fromUid, "offer", { type: offer.type, sdp: offer.sdp });
    showLiveBanner(fromName);
    if (state.liveTimeout) clearTimeout(state.liveTimeout);
    state.liveTimeout = setTimeout(function () {
      if (state.rtc && state.rtc.role === "streamer" && pc.connectionState !== "connected") {
        endStream(true);
        toast("Streaming dibatalkan (tidak tersambung).");
      }
    }, 30000);
  } catch (err) {
    console.error(err);
    toast("Gagal mulai streaming: " + (err.message || err));
    rtcSend(fromUid, "denied", { reason: "gagal di HP target" });
  }
}

// Sisi yang DITONTON: terima answer dari penonton.
// payload bisa berupa objek {type,sdp} langsung dari RTDB atau string sdp.
async function onStreamAnswer(fromUid, desc) {
  const r = state.rtc;
  if (!r || r.role !== "streamer" || r.peerUid !== fromUid || !r.pc) return;
  try {
    const init = (desc && typeof desc === "object") ? desc : { type: "answer", sdp: desc };
    await r.pc.setRemoteDescription(init);
    flushIce();
  } catch (e) {
    console.error(e);
    endStream(false);
  }
}

function onIceFrom(fromUid, cand) {
  const r = state.rtc;
  if (!r || r.peerUid !== fromUid || !r.pc || !cand) return;
  if (r.pc.remoteDescription) r.pc.addIceCandidate(cand).catch(function () {});
  else r.pendingIce.push(cand);
}

function flushIce() {
  const r = state.rtc;
  if (!r || !r.pc || !r.pc.remoteDescription) return;
  while (r.pendingIce.length) r.pc.addIceCandidate(r.pendingIce.shift()).catch(function () {});
}

// ICE "disconnected" sering pulih sendiri; anggap putus permanen kalau
// 8 detik tetap disconnected (mis. halaman rekan ditutup tanpa pesan "ended").
function watchIce(pc, onGone) {
  pc.oniceconnectionstatechange = function () {
    if (pc.iceConnectionState !== "disconnected") return;
    setTimeout(function () {
      if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed") {
        if (state.rtc && state.rtc.pc === pc) onGone();
      }
    }, 8000);
  };
}

// Matikan streaming (kedua peran). notifyPeer = kirim pesan "ended" ke rekan.
function endStream(notifyPeer) {
  if (state.liveTimeout) { clearTimeout(state.liveTimeout); state.liveTimeout = null; }
  const r = state.rtc;
  state.rtc = null;
  if (r) {
    if (r.pc) { try { r.pc.close(); } catch (e) { /* abaikan */ } }
    if (r.stream) r.stream.getTracks().forEach(function (t) { t.stop(); });
    if (notifyPeer && r.peerUid) rtcSend(r.peerUid, "ended", {});
    if (r.role === "streamer") hideLiveBanner();
  }
  const v = $("liveVideo");
  if (v.srcObject) {
    try { v.srcObject.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* abaikan */ }
    v.srcObject = null;
  }
  v.style.display = "none";
  $("stopStreamBtn").hidden = true;
}

// Router pesan signaling masuk (dipanggil dari scanCommands)
function handleRtcMessage(m, fromUid, fromName) {
  const type = m.type;
  if (type === "streamRequest") {
    if (state.capturing) { rtcSend(fromUid, "denied", { reason: "sedang merekam" }); return; }
    if (state.rtc) { rtcSend(fromUid, "denied", { reason: "sedang streaming" }); return; }
    if (hasPerm(fromUid)) {
      toast("Auto-diizinkan (izin tersimpan): streaming dari " + fromName);
      startStreamerSession(fromUid, fromName);
      return;
    }
    if (state.modal) { rtcSend(fromUid, "denied", { reason: "ada dialog lain" }); return; }
    showApprovalModal(null, { action: "stream" }, fromName, function (accepted) {
      if (accepted) {
        grantPerm(fromUid, fromName);
        startStreamerSession(fromUid, fromName);
      } else {
        rtcSend(fromUid, "denied", { reason: "ditolak" });
        toast("Permintaan streaming dari " + fromName + " ditolak.");
      }
    });
    return;
  }
  if (type === "offer") { onStreamOffer(fromUid, fromName, m.payload && m.payload.sdp); return; }
  if (type === "answer") { onStreamAnswer(fromUid, m.payload); return; }
  if (type === "ice") { onIceFrom(fromUid, m.payload); return; }
  if (type === "rtcStop") {
    if (state.rtc && state.rtc.role === "streamer") {
      endStream(false);
      $("streamStatus").textContent = "Streaming dihentikan dari HP pengirim.";
      toast("Streaming dihentikan dari HP pengirim.");
    }
    return;
  }
  if (type === "ended") {
    if (state.rtc && state.rtc.role === "viewer") {
      endStream(false);
      $("streamStatus").textContent = "Streaming berakhir di HP tujuan.";
    }
    return;
  }
  if (type === "denied") {
    if (state.rtc && state.rtc.role === "viewer" && !state.rtc.pc) {
      endStream(false);
      $("streamStatus").textContent = "Streaming ditolak: " + ((m.payload && m.payload.reason) || "ditolak di HP tujuan");
      toast("Permintaan streaming ditolak.");
    }
    return;
  }
}

function showLiveBanner(fromName) {
  const el = document.createElement("div");
  el.className = "notice";
  el.style.cssText = "position:fixed;top:12px;left:12px;right:12px;z-index:215;max-width:560px;margin:0 auto;align-items:center";
  el.innerHTML = '<div class="notice-icon" style="background:#ff5a5a">●</div><div style="flex:1"><strong>LIVE — KAMERA & MIKROFON AKTIF</strong><p>' + escapeHtml(fromName) + ' sedang menonton & mendengar HP ini secara langsung.</p></div>';
  const btn = document.createElement("button");
  btn.className = "btn btn-ghost";
  btn.textContent = "MATIKAN";
  btn.style.marginLeft = "8px";
  btn.addEventListener("click", function () {
    const r = state.rtc;
    endStream(true);
    $("streamStatus").textContent = "Streaming dimatikan di HP ini.";
    toast("Streaming dimatikan.");
    if (r && r.peerUid) { /* pesan ended sudah dikirim endStream(true) */ }
  });
  el.appendChild(btn);
  document.body.appendChild(el);
  state.liveBanner = el;
}
function hideLiveBanner() {
  if (state.liveBanner) { state.liveBanner.remove(); state.liveBanner = null; }
}

/* ============================================================
 * LOKASI: kirim saat berpindah + ulang otomatis tiap 30 detik
 * ============================================================ */
function sendCurrentPosition() {
  if (!state.deviceRef || state.watchId === null && !state.locTimer) return;
  navigator.geolocation.getCurrentPosition(function (pos) {
    if (!state.deviceRef) return;
    const lat = pos.coords.latitude, lng = pos.coords.longitude, acc = pos.coords.accuracy;
    state.deviceRef.update({ lat: lat, lng: lng, accuracy: acc, locationUpdatedAt: firebase.database.ServerValue.TIMESTAMP })
      .then(function () {
        if (state.watchId !== null || state.locTimer) {
          $("locationState").textContent = "Aktif • kirim tiap 30 dtk • akurasi ±" + Math.round(acc) + " m";
        }
      })
      .catch(function (err) { console.error(err); toast("Gagal mengirim lokasi."); });
  }, function (err) { console.warn("lokasi berkala:", err.message); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
}

function startLocation() {
  if (!state.user || !state.deviceRef) {
    toast("Hubungkan dan pairing perangkat terlebih dahulu.");
    $("locationToggle").checked = false; return;
  }
  if (!navigator.geolocation) {
    toast("Browser ini tidak mendukung GPS.");
    $("locationToggle").checked = false; return;
  }
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  if (state.locTimer) clearInterval(state.locTimer);
  $("locationState").textContent = "Meminta izin lokasi…";
  state.watchId = navigator.geolocation.watchPosition(async pos => {
    const { latitude, longitude, accuracy } = pos.coords;
    try {
      await state.deviceRef.update({ lat: latitude, lng: longitude, accuracy: accuracy, locationUpdatedAt: firebase.database.ServerValue.TIMESTAMP });
      $("locationState").textContent = "Aktif • kirim tiap 30 dtk • akurasi ±" + Math.round(accuracy) + " m";
    } catch (err) { console.error(err); toast("Gagal mengirim lokasi."); }
  }, err => {
    if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    if (state.locTimer) clearInterval(state.locTimer);
    state.locTimer = null;
    $("locationToggle").checked = false;
    $("locationState").textContent = "Nonaktif • kirim tiap 30 detik saat aktif";
    toast("Izin lokasi gagal: " + err.message);
  }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  // Pengirim ulang otomatis tiap 30 detik walau HP diam di tempat
  state.locTimer = setInterval(sendCurrentPosition, 30000);
}

async function stopLocation() {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  if (state.locTimer) clearInterval(state.locTimer);
  state.locTimer = null;
  $("locationState").textContent = "Nonaktif • kirim tiap 30 detik saat aktif";
  if (state.deviceRef) {
    try { await state.deviceRef.update({ lat: null, lng: null, accuracy: null, locationUpdatedAt: null }); } catch (e) { console.warn(e); }
  }
}

async function disconnect() {
  await stopLocation();
  stopRing(false);
  endStream(true);
  hideModal();
  hideRecBanner();
  if (state.deviceRef) {
    try {
      await state.deviceRef.onDisconnect().cancel();
      await state.deviceRef.update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP });
    } catch (e) { console.warn(e); }
  }
  if (state.devicesRef) state.devicesRef.off();
  if (state.user) {
    try { await firebase.auth().signOut(); } catch (e) { console.warn(e); }
  }
  state.user = null; state.roomId = null; state.roomRef = null; state.devicesRef = null; state.deviceRef = null;
  state.pendingConnect = false;
  state.pendingCommands = {}; state.handled = {}; state.rtcHandled = {}; state.lastRingTarget = null;
  localStorage.removeItem(ROOM_KEY);
  enableControls(false); setConnection(false);
  setStatus("Terputus."); setPairStatus("Hubungkan perangkat terlebih dahulu.");
  $("roomCode").textContent = "--------"; $("copyCodeBtn").disabled = true;
  $("deviceList").innerHTML = EMPTY_DEVICES;
  $("locationList").innerHTML = EMPTY_LOCATIONS;
  $("locationToggle").checked = false; $("locationState").textContent = "Nonaktif • kirim tiap 30 detik saat aktif";
  $("mediaList").innerHTML = EMPTY_MEDIA;
  $("captureStatus").textContent = "Hubungkan dan pairing untuk pakai fitur remote.";
  $("targetDevice").innerHTML = '<option value="">Hubungkan dan pairing dulu…</option>';
  $("ringStopBtn").hidden = true;
  $("streamStatus").textContent = "Tidak ada streaming aktif.";
  toast("Perangkat diputuskan.");
}

/* ============================================================
 * EVENT LISTENERS
 * ============================================================ */
$("connectBtn").addEventListener("click", connect);
$("disconnectBtn").addEventListener("click", disconnect);
$("createRoomBtn").addEventListener("click", createRoom);
$("joinRoomBtn").addEventListener("click", joinRoom);
$("locationToggle").addEventListener("change", e => e.target.checked ? startLocation() : stopLocation());
$("deviceName").addEventListener("change", updateDeviceName);
$("joinCode").addEventListener("keydown", e => {
  if (e.key === "Enter" && !$("joinRoomBtn").disabled) joinRoom();
});
$("photoBtn").addEventListener("click", function () { sendCommand($("targetDevice").value, "photo"); });
$("videoBtn").addEventListener("click", function () { sendCommand($("targetDevice").value, "video"); });
$("audioBtn").addEventListener("click", function () { sendCommand($("targetDevice").value, "audio"); });
$("streamBtn").addEventListener("click", function () { startStream($("targetDevice").value); });
$("stopStreamBtn").addEventListener("click", function () {
  if (state.rtc && state.rtc.role === "viewer") {
    const peer = state.rtc.peerUid;
    endStream(false);
    rtcSend(peer, "rtcStop", {});
    $("streamStatus").textContent = "Streaming dihentikan.";
  }
});
$("ringBtn").addEventListener("click", function () { sendCommand($("targetDevice").value, "ring"); });
$("ringStopBtn").addEventListener("click", function () {
  if (state.lastRingTarget) sendCommand(state.lastRingTarget, "ringStop", true); // umpan balik asli datang dari status "stopped"
  $("ringStopBtn").hidden = true;
});
$("ringToggle").addEventListener("change", function (e) {
  const on = e.target.checked;
  localStorage.setItem(RING_KEY, on ? "1" : "0");
  $("ringState").textContent = on ? "Aktif — HP ini boleh dibunyikan dari jarak jauh" : "Nonaktif";
  if (on) audioUnlock();
});
$("copyCodeBtn").addEventListener("click", async () => {
  const code = $("roomCode").textContent;
  if (!code || code === "--------") return;
  const ok = await copyText(code);
  toast(ok ? "Kode disalin." : "Salin kode secara manual: " + code);
});
$("joinCode").addEventListener("input", e => e.target.value = e.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, ""));
window.addEventListener("beforeunload", function () {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  if (state.locTimer) clearInterval(state.locTimer);
  stopRing(false);
  endStream(true); // beri tahu rekan streaming bahwa halaman ditutup
});

// Init
enableControls(false);
// Notice cuma ditampilkan kalau config memang belum diisi
$("setupNotice").style.display = firebaseReady() ? "none" : "";
// Pakai nama perangkat yang pernah disimpan sebelumnya
if (!$("deviceName").value) {
  const savedName = localStorage.getItem(NAME_KEY);
  if (savedName) $("deviceName").value = savedName;
}
// Preferensi nada dering remote (izin penerima, disimpan lokal)
$("ringToggle").checked = localStorage.getItem(RING_KEY) === "1";
$("ringState").textContent = $("ringToggle").checked ? "Aktif — HP ini boleh dibunyikan dari jarak jauh" : "Nonaktif";
// Daftar izin tersimpan per HP pengirim (sekali izin, bisa dicabut)
renderPerms();
// Pantau perintah yang tidak kunjung dijawab
setInterval(tickPending, 15000);
// Init Firebase: pulihkan sesi login & pantau koneksi realtime yang sebenarnya
if (typeof firebase !== "undefined" && firebaseReady()) {
  firebase.initializeApp(firebaseConfig);
  firebase.auth().onAuthStateChanged(handleAuthState);
  firebase.database().ref(".info/connected").on("value", s => {
    state.rtdbConnected = !!s.val();
    refreshConnection();
  });
} else if (typeof firebase === "undefined") {
  setStatus("Library Firebase tidak termuat. Cek koneksi internet.");
}

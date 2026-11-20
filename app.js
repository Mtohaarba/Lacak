/* EKHM v0.2
 * Prototype: anonymous Firebase login, private room pairing, online status, opt-in GPS sharing (repeat 30 dtk),
 * remote capture (foto/video/audio) dan nada dering remote — SEMUA dengan izin di HP penerima:
 *  - foto/video/audio: selalu ada dialog persetujuan setiap kali diminta + indikator kamera/mikrofon dari browser
 *  - nada dering: hanya jalan kalau saklar "Nada dering remote" di HP penerima aktif
 * Rules Realtime Database yang dibutuhkan (sudah sesuai project):
 *  - auth user membuat ruang baru, join sebagai member, member membaca ruangnya
 *  - devices/$uid hanya bisa ditulis oleh uid sendiri (termasuk children commands/ dan media/)
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
  modal: null, capturing: null, recBanner: null, pendingCommands: {}, handled: {}
};

// Kode ruang, nama perangkat & preferensi izin disimpan lokal supaya
// sesi dan pairing tetap ada setelah halaman di-refresh.
const ROOM_KEY = "ekhm_room";
const NAME_KEY = "ekhm_name";
const RING_KEY = "ekhm_ring";

const EMPTY_DEVICES = '<div class="empty-state"><span>⌁</span><p>Belum ada perangkat terhubung.</p></div>';
const EMPTY_LOCATIONS = '<p class="muted">Lokasi perangkat akan tampil di sini setelah dibagikan.</p>';
const EMPTY_MEDIA = '<p class="muted">Belum ada foto/video/audio. Hasil remote capture akan tampil di sini.</p>';
const ACTION_LABEL = { photo: "FOTO", video: "VIDEO", audio: "AUDIO", ring: "NADA DERING", ringStop: "MATIKAN BUNYI" };

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
  ["createRoomBtn", "joinRoomBtn", "locationToggle", "photoBtn", "videoBtn", "audioBtn", "ringBtn"].forEach(id => $(id).disabled = !on);
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

function renderMedia(snapshot) {
  const list = $("mediaList"); list.innerHTML = "";
  const items = [];
  snapshot.forEach(child => {
    const d = child.val() || {};
    const media = d.media || {};
    Object.keys(media).forEach(k => {
      const v = media[k] || {};
      if (typeof v.data !== "string" || !v.data) return;
      items.push({ uid: child.key, name: d.name || "Perangkat", type: v.type, mime: v.mime, data: v.data, ts: v.ts || 0 });
    });
  });
  items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (!items.length) { list.innerHTML = EMPTY_MEDIA; return; }
  items.slice(0, 12).forEach(v => {
    const item = document.createElement("div");
    item.className = "location-item";
    const label = ACTION_LABEL[v.type] || "MEDIA";
    const when = v.ts ? new Date(v.ts).toLocaleTimeString("id-ID") : "";
    let body = "";
    if (v.type === "photo") {
      body = '<img src="data:image/jpeg;base64,' + v.data + '" alt="foto remote" style="max-width:100%;border-radius:8px;margin-top:8px">';
    } else if (v.type === "video") {
      body = '<video controls playsinline src="data:' + escapeHtml(v.mime || "video/webm") + ';base64,' + v.data + '" style="width:100%;max-height:300px;border-radius:8px;margin-top:8px"></video>';
    } else {
      body = '<audio controls src="data:' + escapeHtml(v.mime || "audio/webm") + ';base64,' + v.data + '" style="width:100%;margin-top:8px"></audio>';
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
  // foto/video/audio -> WAJIB dialog persetujuan, setiap kali
  if (state.modal || state.capturing) {
    setCommandStatus(cid, "denied");
    toast("Ada permintaan lain yang sedang berjalan — permintaan " + fromName + " ditolak.");
    return;
  }
  showApprovalModal(cid, cmd, fromName, function (accepted) {
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
    '<p class="muted" style="margin-bottom:4px">Izin ini muncul setiap kali diminta. Saat perekaman berjalan kamu bisa membatalkan kapan saja.</p>';
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

function blobToBase64(blob) {
  return new Promise(function (resolve, reject) {
    const r = new FileReader();
    r.onload = function () { resolve(String(r.result).split(",")[1]); };
    r.onerror = function () { reject(new Error("Gagal membaca hasil rekaman.")); };
    r.readAsDataURL(blob);
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
    type: result.type, mime: result.mime || null, data: result.data, dur: result.dur || null,
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
  state.pendingCommands = {}; state.handled = {}; state.lastRingTarget = null;
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

/* EKHM v0.1
 * Prototype: anonymous Firebase login, private room pairing, online status and opt-in GPS sharing.
 * IMPORTANT: Pasang Realtime Database Rules dari database.rules.json. Jangan pakai test mode untuk data lokasi.
 */
const firebaseConfig = {
  apiKey: "AIzaSyCGGiag9QO1hT4OeeVIbnBJaPB8Wwp9y3M",
  authDomain: "ekhm-48.firebaseapp.com",
  databaseURL: "https://ekhm-48-default-rtdb.asia-southeast1.firebasedatabase.app", // tanpa spasi & tanpa slash di akhir
  projectId: "ekhm-48",
  appId: "1:199798166148:web:b34ea26a207e9826eb68d1"
};

const $ = (id) => document.getElementById(id);
const state = { user: null, roomId: null, roomRef: null, devicesRef: null, watchId: null, deviceRef: null, connected: false };

const EMPTY_DEVICES = '<div class="empty-state"><span>⌁</span><p>Belum ada perangkat terhubung.</p></div>';
const EMPTY_LOCATIONS = '<p class="muted">Lokasi perangkat akan tampil di sini setelah dibagikan.</p>';

const randomCode = () => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => chars[b % chars.length]).join("");
};
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 2800);
}
function setStatus(message) { $("authStatus").textContent = message; }
function setPairStatus(message) { $("pairStatus").textContent = message; }
function setConnection(online) {
  const top = document.querySelector(".top-status");
  top.classList.toggle("online", !!online);
  $("connectionLabel").textContent = online ? "TERHUBUNG" : "BELUM TERHUBUNG";
}
function firebaseReady() {
  const placeholders = ["ISI_API_KEY", "ISI_PROJECT_ID", "ISI_APP_ID"];
  return !!firebaseConfig.apiKey && !!firebaseConfig.projectId && !!firebaseConfig.appId &&
    !placeholders.includes(firebaseConfig.apiKey) &&
    !placeholders.includes(firebaseConfig.projectId) &&
    !placeholders.includes(firebaseConfig.appId);
}
function enableControls(on) {
  ["createRoomBtn", "joinRoomBtn", "locationToggle"].forEach(id => $(id).disabled = !on);
  $("connectBtn").disabled = on;
  $("disconnectBtn").disabled = !on;
}
function isPermissionError(err) {
  return err && (err.code === "PERMISSION_DENIED" || /permission_denied/i.test(err.message || ""));
}

async function connect() {
  if (!firebaseReady()) {
    $("setupNotice").style.display = "";
    toast("Isi konfigurasi Firebase di js/app.js terlebih dahulu.");
    setStatus("Firebase belum dikonfigurasi.");
    return;
  }
  if (typeof firebase === "undefined") {
    toast("Library Firebase gagal dimuat. Cek koneksi internet.");
    setStatus("Library Firebase tidak termuat.");
    return;
  }
  try {
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    const result = await firebase.auth().signInAnonymously();
    state.user = result.user;
    state.connected = true;
    enableControls(true);
    setConnection(true);
    setStatus("Terhubung sebagai perangkat: " + state.user.uid.slice(0, 8));
    $("setupNotice").style.display = "none";
    toast("Perangkat berhasil terhubung.");
  } catch (err) {
    console.error(err);
    setStatus("Gagal terhubung: " + err.message);
    toast("Gagal login Firebase. Pastikan Anonymous sign-in aktif dan domain sudah diizinkan.");
  }
}

async function updateDeviceName() {
  if (!state.user || !state.deviceRef) return;
  const name = $("deviceName").value.trim() || "Perangkat EKHM";
  try {
    await state.deviceRef.update({
      name,
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
  if (!/^[A-HJ-NP-Z2-9]{10}$/.test(code)) {
    toast("Kode harus terdiri dari 10 karakter."); return;
  }
  try {
    // Langsung daftar sebagai member. Rules hanya mengizinkan kalau ruangnya ada,
    // jadi non-member tidak perlu (dan tidak boleh) membaca ruang lebih dulu.
    await firebase.database().ref("rooms/" + code + "/members/" + state.user.uid).set(true);
    await enterRoom(code);
    $("roomCode").textContent = code;
    $("copyCodeBtn").disabled = false;
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
  state.devicesRef.on("value", renderDevices, err => {
    console.error(err);
    toast("Gagal membaca daftar perangkat.");
  });
}

function renderDevices(snapshot) {
  const list = $("deviceList"); list.innerHTML = "";
  if (!snapshot.exists()) { list.innerHTML = EMPTY_DEVICES; $("locationList").innerHTML = EMPTY_LOCATIONS; return; }
  snapshot.forEach(child => {
    const d = child.val() || {};
    const isSelf = child.key === state.user?.uid;
    const hasLoc = typeof d.lat === "number" && typeof d.lng === "number";
    const item = document.createElement("div");
    item.className = "device-item";
    item.innerHTML = `<div><div class="device-name">${escapeHtml(d.name || "Perangkat")}${isSelf ? " (HP ini)" : ""}</div><div class="device-meta">${hasLoc ? "Lokasi tersedia" : "Lokasi belum dibagikan"}</div></div><span class="online-pill">${d.online ? "ONLINE" : "OFFLINE"}</span>`;
    list.appendChild(item);
  });
  renderLocations(snapshot);
}

function renderLocations(snapshot) {
  const list = $("locationList"); list.innerHTML = "";
  let found = false;
  snapshot.forEach(child => {
    const d = child.val() || {};
    if (typeof d.lat !== "number" || typeof d.lng !== "number") return;
    found = true;
    const item = document.createElement("div"); item.className = "location-item";
    const name = escapeHtml(d.name || "Perangkat");
    const coords = `${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}`;
    item.innerHTML = `<strong>${name}${child.key === state.user?.uid ? " (HP ini)" : ""}</strong><small>${coords}<br><a href="https://www.google.com/maps?q=${encodeURIComponent(d.lat + "," + d.lng)}" target="_blank" rel="noopener">Buka di Google Maps ↗</a></small>`;
    list.appendChild(item);
  });
  if (!found) list.innerHTML = '<p class="muted">Belum ada perangkat yang membagikan lokasi.</p>';
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
  $("locationState").textContent = "Meminta izin lokasi…";
  state.watchId = navigator.geolocation.watchPosition(async pos => {
    const { latitude, longitude, accuracy } = pos.coords;
    try {
      await state.deviceRef.update({ lat: latitude, lng: longitude, accuracy, locationUpdatedAt: firebase.database.ServerValue.TIMESTAMP });
      $("locationState").textContent = "Aktif • akurasi ±" + Math.round(accuracy) + " m";
    } catch (err) { console.error(err); toast("Gagal mengirim lokasi."); }
  }, err => {
    if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    $("locationToggle").checked = false;
    $("locationState").textContent = "Nonaktif";
    toast("Izin lokasi gagal: " + err.message);
  }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
}

async function stopLocation() {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  $("locationState").textContent = "Nonaktif";
  if (state.deviceRef) {
    try { await state.deviceRef.update({ lat: null, lng: null, accuracy: null, locationUpdatedAt: null }); } catch (e) { console.warn(e); }
  }
}

async function disconnect() {
  await stopLocation();
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
  state.user = null; state.roomId = null; state.roomRef = null; state.devicesRef = null; state.deviceRef = null; state.connected = false;
  enableControls(false); setConnection(false);
  setStatus("Terputus."); setPairStatus("Hubungkan perangkat terlebih dahulu.");
  $("roomCode").textContent = "--------"; $("copyCodeBtn").disabled = true;
  $("deviceList").innerHTML = EMPTY_DEVICES;
  $("locationList").innerHTML = EMPTY_LOCATIONS;
  $("locationToggle").checked = false; $("locationState").textContent = "Nonaktif";
  toast("Perangkat diputuskan.");
}

$("connectBtn").addEventListener("click", connect);
$("disconnectBtn").addEventListener("click", disconnect);
$("createRoomBtn").addEventListener("click", createRoom);
$("joinRoomBtn").addEventListener("click", joinRoom);
$("locationToggle").addEventListener("change", e => e.target.checked ? startLocation() : stopLocation());
$("deviceName").addEventListener("change", updateDeviceName);
$("copyCodeBtn").addEventListener("click", async () => {
  const code = $("roomCode").textContent;
  try { await navigator.clipboard.writeText(code); toast("Kode disalin."); }
  catch { toast("Salin kode secara manual: " + code); }
});
$("joinCode").addEventListener("input", e => e.target.value = e.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, ""));
window.addEventListener("beforeunload", () => {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
});

// Init
enableControls(false);
// Notice cuma ditampilkan kalau config memang belum diisi
$("setupNotice").style.display = firebaseReady() ? "none" : "";
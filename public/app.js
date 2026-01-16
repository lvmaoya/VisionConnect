const roomInput = document.getElementById('room');
const joinBtn = document.getElementById('join');
const leaveBtn = document.getElementById('leave');
const muteBtn = document.getElementById('mute');
const videoBtn = document.getElementById('video');
const shareBtn = document.getElementById('share');
const videos = document.getElementById('videos');
const localVideo = document.getElementById('v-local');
const toastBox = document.getElementById('toastBox');

let ws = null;
let roomId = null;
let localStream = null;
let screenStream = null;
let peers = new Map();
let senders = new Map();
let audioEnabled = true;
let videoEnabled = true;
let sharing = false;

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}`;
}

function pcConfig() {
  return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
}

function setEnabled(el, enabled) {
  el.disabled = !enabled;
}

function setupUIJoined(joined) {
  setEnabled(roomInput, !joined);
  setEnabled(joinBtn, !joined);
  setEnabled(leaveBtn, joined);
  setEnabled(muteBtn, joined);
  setEnabled(videoBtn, joined);
  setEnabled(shareBtn, joined);
}

function createVideo(id) {
  let v = document.getElementById('v-' + id);
  if (!v) {
    const tile = document.createElement('div');
    tile.className = 'relative';
    v = document.createElement('video');
    v.id = 'v-' + id;
    v.autoplay = true;
    v.playsInline = true;
    v.className = 'w-full h-auto aspect-video bg-[#1a1c20] border border-[#2a2d33] rounded-xl object-cover shadow-sm';
    const label = document.createElement('div');
    label.className = 'absolute left-2 bottom-2 px-2 py-1 rounded-lg bg-black/40 text-white text-xs';
    label.textContent = id.slice(0,6);
    tile.appendChild(v);
    tile.appendChild(label);
    videos.appendChild(tile);
  }
  return v;
}

function showError(s) {
  if (!toastBox) return;
  while (toastBox.firstChild) toastBox.removeChild(toastBox.firstChild);
  if (!s) return;
  const t = document.createElement('div');
  t.className = 'pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl bg-black/80 text-white border border-white/10 shadow-2xl transform transition-all duration-150 ease-out opacity-0 -translate-y-3';
  const span = document.createElement('div');
  span.textContent = s;
  const btn = document.createElement('button');
  btn.className = 'ml-2 text-white/90 hover:bg-white/10 rounded-md px-2 py-1';
  btn.textContent = '关闭';
  btn.addEventListener('click', () => {
    t.classList.add('opacity-0','-translate-y-3');
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 150);
  });
  t.appendChild(span);
  t.appendChild(btn);
  toastBox.appendChild(t);
  requestAnimationFrame(() => {
    t.classList.remove('opacity-0','-translate-y-3');
    t.classList.add('opacity-100','translate-y-0');
  });
  setTimeout(() => {
    if (t.parentNode) {
      t.classList.add('opacity-0','-translate-y-3');
      setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 150);
    }
  }, 5000);
}

function clearError() {
  if (!toastBox) return;
  while (toastBox.firstChild) toastBox.removeChild(toastBox.firstChild);
}

async function resilientGetUserMedia() {
  clearError();
  try {
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) {
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const hasMic = devices.some(d => d.kind === 'audioinput');
    const hasCam = devices.some(d => d.kind === 'videoinput');
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
      showError('请允许浏览器访问摄像头/麦克风');
      throw e;
    }
    if (!hasMic && !hasCam) {
      showError('未检测到麦克风或摄像头');
      throw e;
    }
    if (hasMic && !hasCam) {
      showError('未检测到摄像头，将仅加入语音');
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    if (hasCam && !hasMic) {
      showError('未检测到麦克风，将仅加入视频');
      return await navigator.mediaDevices.getUserMedia({ video: true });
    }
    showError('设备不可用或被占用，请检查系统权限');
    throw e;
  }
}

function updateControlStatesFromStream() {
  const hasAudio = localStream && localStream.getAudioTracks().length > 0;
  const hasVideo = localStream && localStream.getVideoTracks().length > 0;
  setEnabled(muteBtn, !!hasAudio);
  setEnabled(videoBtn, !!hasVideo);
  muteBtn.textContent = hasAudio && audioEnabled ? '静音' : '取消静音';
  videoBtn.textContent = hasVideo && videoEnabled ? '关闭视频' : '打开视频';
}

async function startLocal() {
  localStream = await resilientGetUserMedia();
  localVideo.srcObject = localStream;
  audioEnabled = localStream.getAudioTracks().length > 0;
  videoEnabled = localStream.getVideoTracks().length > 0;
  updateControlStatesFromStream();
}

function stopStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach(t => t.stop());
}

function addPeer(id, initiator) {
  const pc = new RTCPeerConnection(pcConfig());
  peers.set(id, pc);
  const hasLocalTracks = localStream && localStream.getTracks().length > 0;
  if (hasLocalTracks) {
    localStream.getTracks().forEach(track => {
      const sender = pc.addTrack(track, localStream);
      if (!senders.has(id)) senders.set(id, []);
      senders.get(id).push(sender);
    });
  } else {
    try {
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
    } catch (_) {}
  }
  pc.onicecandidate = e => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: 'signal', roomId, target: id, data: { type: 'candidate', candidate: e.candidate } }));
    }
  };
  pc.ontrack = e => {
    const v = createVideo(id);
    v.srcObject = e.streams[0];
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
      removePeer(id);
    }
  };
  if (initiator) {
    pc.createOffer().then(offer => {
      pc.setLocalDescription(offer).then(() => {
        ws.send(JSON.stringify({ type: 'signal', roomId, target: id, data: { type: 'offer', sdp: pc.localDescription } }));
      });
    });
  }
  return pc;
}

function removePeer(id) {
  const pc = peers.get(id);
  if (pc) pc.close();
  peers.delete(id);
  senders.delete(id);
  const v = document.getElementById('v-' + id);
  if (v && v.parentNode) v.parentNode.removeChild(v);
}

function handleSignal(from, data) {
  let pc = peers.get(from);
  if (data.type === 'offer') {
    if (!pc) pc = addPeer(from, false);
    pc.setRemoteDescription(data.sdp).then(() => {
      pc.createAnswer().then(ans => {
        pc.setLocalDescription(ans).then(() => {
          ws.send(JSON.stringify({ type: 'signal', roomId, target: from, data: { type: 'answer', sdp: pc.localDescription } }));
        });
      });
    });
  } else if (data.type === 'answer') {
    if (pc) pc.setRemoteDescription(data.sdp);
  } else if (data.type === 'candidate') {
    if (pc) pc.addIceCandidate(data.candidate);
  }
}

function replaceVideoTrack(track) {
  localStream.getVideoTracks().forEach(t => t.stop());
  localStream = new MediaStream([track, ...localStream.getAudioTracks()]);
  localVideo.srcObject = localStream;
  peers.forEach((pc, id) => {
    pc.getSenders().forEach(s => {
      if (s.track && s.track.kind === 'video') s.replaceTrack(track);
    });
  });
}

function toggleAudio() {
  audioEnabled = !audioEnabled;
  localStream.getAudioTracks().forEach(t => t.enabled = audioEnabled);
  muteBtn.textContent = audioEnabled ? '静音' : '取消静音';
}

function toggleVideo() {
  videoEnabled = !videoEnabled;
  localStream.getVideoTracks().forEach(t => t.enabled = videoEnabled);
  videoBtn.textContent = videoEnabled ? '关闭视频' : '打开视频';
}

async function toggleShare() {
  if (!sharing) {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const track = screenStream.getVideoTracks()[0];
    replaceVideoTrack(track);
    sharing = true;
    shareBtn.textContent = '停止共享';
    track.onended = () => {
      if (sharing) toggleShare();
    };
  } else {
    stopStream(screenStream);
    const cam = await navigator.mediaDevices.getUserMedia({ video: true });
    const track = cam.getVideoTracks()[0];
    replaceVideoTrack(track);
    cam.getVideoTracks().forEach(t => t.stop());
    sharing = false;
    shareBtn.textContent = '共享屏幕';
  }
}

function connect() {
  ws = new WebSocket(wsUrl());
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', roomId }));
    setupUIJoined(true);
    updateControlStatesFromStream();
  };
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'participants') {
      msg.ids.forEach(id => addPeer(id, true));
    } else if (msg.type === 'peer-joined') {
      addPeer(msg.id, true);
    } else if (msg.type === 'peer-left') {
      removePeer(msg.id);
      appendChat({ from: '系统', text: `${msg.id.slice(0,6)} 离开房间` });
    } else if (msg.type === 'signal') {
      handleSignal(msg.from, msg.data);
    } else if (msg.type === 'chat') {
      appendChat({ from: msg.from.slice(0,6), text: msg.text });
    }
  };
  ws.onclose = () => {
    setupUIJoined(false);
  };
}

function leave() {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'leave', roomId }));
  if (ws) ws.close();
  peers.forEach((_pc, id) => removePeer(id));
  stopStream(localStream);
  stopStream(screenStream);
  localVideo.srcObject = null;
}

joinBtn.addEventListener('click', async () => {
  roomId = roomInput.value.trim() || 'lobby';
  try {
    await startLocal();
    audioEnabled = false;
    videoEnabled = false;
    localStream.getAudioTracks().forEach(t => t.enabled = false);
    localStream.getVideoTracks().forEach(t => t.enabled = false);
    updateControlStatesFromStream();
    connect();
  } catch (e) {
    setupUIJoined(false);
  }
});

leaveBtn.addEventListener('click', () => {
  leave();
});

muteBtn.addEventListener('click', toggleAudio);
videoBtn.addEventListener('click', toggleVideo);
shareBtn.addEventListener('click', () => { toggleShare(); });

const chatInput = document.getElementById('chatInput');
const chatSend = document.getElementById('chatSend');
const chatList = document.getElementById('chatList');

function appendChat({ from, text }) {
  if (!chatList) return;
  const item = document.createElement('div');
  item.className = 'text-white';
  const name = document.createElement('div');
  name.className = 'text-xs text-white/60';
  name.textContent = from || '你';
  const bubble = document.createElement('div');
  bubble.className = 'mt-1 px-3 py-2 rounded-xl bg-white/10 text-white';
  bubble.textContent = text || '';
  item.appendChild(name);
  item.appendChild(bubble);
  chatList.appendChild(item);
  chatList.scrollTop = chatList.scrollHeight;
}

function sendChat() {
  const text = (chatInput && chatInput.value || '').trim();
  if (!text) return;
  appendChat({ from: '你', text });
  chatInput.value = '';
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'chat', roomId, text }));
  }
}

if (chatSend) chatSend.addEventListener('click', sendChat);
if (chatInput) chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

try {
  const params = new URLSearchParams(location.search);
  const key = params.get('key') || params.get('room') || params.get('id');
  if (key && roomInput) {
    roomInput.value = key;
  }
} catch (_) {}

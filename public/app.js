const roomInput = document.getElementById('room');
const joinBtn = document.getElementById('join');
const leaveBtn = document.getElementById('leave');
const muteBtn = document.getElementById('mute');
const videoBtn = document.getElementById('video');
const shareBtn = document.getElementById('share');
const videos = document.getElementById('videos');
const localVideo = document.getElementById('v-local');
const err = document.getElementById('err');

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
    v = document.createElement('video');
    v.id = 'v-' + id;
    v.autoplay = true;
    v.playsInline = true;
    videos.appendChild(v);
  }
  return v;
}

function showError(s) {
  err.textContent = s || '';
  err.style.display = s ? 'block' : 'none';
}

function clearError() {
  showError('');
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
  localStream.getTracks().forEach(track => {
    const sender = pc.addTrack(track, localStream);
    if (!senders.has(id)) senders.set(id, []);
    senders.get(id).push(sender);
  });
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
    } else if (msg.type === 'signal') {
      handleSignal(msg.from, msg.data);
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

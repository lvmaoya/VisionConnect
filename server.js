const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const publicDir = path.join(__dirname, 'public');
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const httpsPort = process.env.HTTPS_PORT ? parseInt(process.env.HTTPS_PORT, 10) : 3443;

const mime = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

function handleRequest(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(publicDir, path.normalize(urlPath));
  if (!filePath.startsWith(publicDir)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath);
    res.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
    res.end(data);
  });
}

const server = http.createServer(handleRequest);

const rooms = new Map();

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, new Map());
  return rooms.get(id);
}

function attachWSS(srv) {
  const wss = new WebSocketServer({ server: srv });
  wss.on('connection', (ws) => {
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    let roomId = null;
  
    ws.on('message', (buf) => {
      let msg = null;
      try { msg = JSON.parse(buf.toString()); } catch (_) { return; }
      if (msg.type === 'join') {
        roomId = msg.roomId || 'lobby';
        const room = getRoom(roomId);
        room.set(id, ws);
        const others = [...room.keys()].filter(k => k !== id);
        ws.send(JSON.stringify({ type: 'participants', ids: others }));
        room.forEach((sock, pid) => {
          if (pid !== id && sock.readyState === WebSocket.OPEN) {
            sock.send(JSON.stringify({ type: 'peer-joined', id }));
          }
        });
      } else if (msg.type === 'signal') {
        if (!roomId) return;
        const room = rooms.get(roomId);
        if (!room) return;
        const target = room.get(msg.target);
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify({ type: 'signal', from: id, data: msg.data }));
        }
      } else if (msg.type === 'leave') {
        cleanup();
      }
    });
  
    ws.on('close', () => {
      cleanup();
    });
  
    function cleanup() {
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;
      room.delete(id);
      room.forEach((sock) => {
        if (sock.readyState === WebSocket.OPEN) {
          sock.send(JSON.stringify({ type: 'peer-left', id }));
        }
      });
      if (room.size === 0) rooms.delete(roomId);
      roomId = null;
    }
  });
  return wss;
}

attachWSS(server);

server.listen(port, '0.0.0.0', () => {
  console.log(`Server running at http://localhost:${port}/`);
});

let httpsServer = null;
if (process.env.HTTPS === '1' || process.env.HTTPS === 'true') {
  try {
    const keyPath = process.env.SSL_KEY || path.join(__dirname, 'cert', 'dev.key');
    const certPath = process.env.SSL_CERT || path.join(__dirname, 'cert', 'dev.crt');
    const options = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };
    httpsServer = https.createServer(options, handleRequest);
    attachWSS(httpsServer);
    httpsServer.listen(httpsPort, '0.0.0.0', () => {
      console.log(`HTTPS Server running at https://localhost:${httpsPort}/`);
    });
  } catch (e) {
    console.error('Failed to start HTTPS server:', e.message);
  }
}

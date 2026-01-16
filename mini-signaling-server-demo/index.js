const WebSocket = require('ws')

const wss = new WebSocket.Server({ port: 3000 })

// 房间：roomId -> Set<WebSocket>
const rooms = new Map()

wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    const data = JSON.parse(msg)

    const { type, roomId } = data

    if (type === 'join') {
      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set())
      }
      rooms.get(roomId).add(ws)
      ws.roomId = roomId
      return
    }

    // 转发给同房间的其他人
    const clients = rooms.get(roomId) || []
    clients.forEach(client => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data))
      }
    })
  })

  ws.on('close', () => {
    const roomId = ws.roomId
    if (!roomId) return

    const clients = rooms.get(roomId)
    if (!clients) return

    clients.delete(ws)
    if (clients.size === 0) {
      rooms.delete(roomId)
    }
  })
})

console.log('Signaling server running at ws://localhost:3000')

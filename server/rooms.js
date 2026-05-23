// Gestión de salas en memoria. Cada sala tiene código único, lista de jugadores
// y, una vez iniciada la partida, todo el estado del juego.

const game = require('./game');

const rooms = new Map();           // code -> room
const socketToRoom = new Map();    // socketId -> code

// Genera un código alfanumérico de 5 caracteres (mayúsculas + dígitos).
// Excluye caracteres confusos (0, O, 1, I).
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function createRoom(name, socketId) {
  const code = generateCode();
  const room = {
    code,
    players: [{ socketId, name, connected: true, hand: [] }],
    status: 'waiting',          // 'waiting' | 'playing' | 'finished' | 'cancelled'
    chain: [],                  // cadena de fichas en la mesa
    turn: 0,                    // índice del jugador en turno
    log: [],                    // historial de movimientos (strings)
    consecutivePasses: 0,
    disconnectTimers: new Map(),// playerIdx -> Timeout
  };
  rooms.set(code, room);
  socketToRoom.set(socketId, code);
  return room;
}

function joinRoom(code, name, socketId) {
  const room = rooms.get(code);
  if (!room) return { error: 'La sala no existe' };

  // Reconexión: jugador con el mismo nombre y marcado como desconectado.
  // Sirve tanto en 'waiting' (refresh, redirect del creador) como en 'playing'.
  const reconnectIdx = room.players.findIndex(p => p.name === name && !p.connected);
  if (reconnectIdx !== -1) {
    const oldSocketId = room.players[reconnectIdx].socketId;
    if (oldSocketId && oldSocketId !== socketId) {
      socketToRoom.delete(oldSocketId);
    }
    room.players[reconnectIdx].socketId = socketId;
    room.players[reconnectIdx].connected = true;
    const timer = room.disconnectTimers.get(reconnectIdx);
    if (timer) {
      clearTimeout(timer);
      room.disconnectTimers.delete(reconnectIdx);
    }
    socketToRoom.set(socketId, code);
    return { room, reconnected: true, playerIdx: reconnectIdx };
  }

  if (room.status === 'playing') return { error: 'La partida ya empezó' };
  if (room.status !== 'waiting') return { error: 'La sala no acepta jugadores' };
  if (room.players.length >= 4) return { error: 'La sala está llena' };
  if (room.players.some(p => p.name === name)) {
    return { error: 'Ese nombre ya está en uso en la sala' };
  }
  room.players.push({ socketId, name, connected: true, hand: [] });
  socketToRoom.set(socketId, code);
  return { room };
}

function getRoomBySocket(socketId) {
  const code = socketToRoom.get(socketId);
  if (!code) return null;
  return rooms.get(code) || null;
}

function getPlayerIndex(room, socketId) {
  return room.players.findIndex(p => p.socketId === socketId);
}

// Maneja desconexión. Devuelve { room, playerIdx, removed } o null.
function handleDisconnect(socketId) {
  const room = getRoomBySocket(socketId);
  if (!room) return null;
  const idx = getPlayerIndex(room, socketId);
  if (idx === -1) return null;
  socketToRoom.delete(socketId);

  // En cualquier estado, marcamos como desconectado y dejamos que index.js
  // programe el timer de gracia. Esto permite que el creador (que se desconecta
  // al ser redirigido de '/' a '/room/CODE') vuelva a entrar con el mismo nombre
  // sin perder la sala.
  room.players[idx].connected = false;
  return { room, playerIdx: idx, removed: false };
}

function deleteRoom(code) {
  const room = rooms.get(code);
  if (room && room.disconnectTimers) {
    for (const t of room.disconnectTimers.values()) clearTimeout(t);
  }
  rooms.delete(code);
}

// Inicializa la partida: reparte fichas y decide quién empieza.
function startGame(room) {
  const hands = game.deal();
  for (let i = 0; i < 4; i++) {
    room.players[i].hand = hands[i];
  }
  const starter = game.findStarter(hands);
  room.status = 'playing';
  room.chain = [];
  room.turn = starter.player;
  room.log = [];
  room.consecutivePasses = 0;
  room.starterTile = starter.tile;
}

module.exports = {
  rooms,
  socketToRoom,
  createRoom,
  joinRoom,
  getRoomBySocket,
  getPlayerIndex,
  handleDisconnect,
  deleteRoom,
  startGame,
};

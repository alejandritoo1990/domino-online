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

function createRoom(name, socketId, mode) {
  let maxPlayers, teams, normalizedMode;
  if (mode === '2p') {
    maxPlayers = 2; teams = false; normalizedMode = '2p';
  } else if (mode === '2v2') {
    maxPlayers = 4; teams = true;  normalizedMode = '2v2';
  } else {
    maxPlayers = 4; teams = false; normalizedMode = '4p';
  }
  const code = generateCode();
  const room = {
    code,
    mode: normalizedMode,
    maxPlayers,
    teams,                       // true → modo parejas (2v2)
    players: [{ socketId, name, connected: true, hand: [] }],
    status: 'waiting',
    chain: [],
    boneyard: [],
    turn: 0,
    log: [],
    consecutivePasses: 0,
    disconnectTimers: new Map(),
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
  if (room.players.length >= room.maxPlayers) return { error: 'La sala está llena' };
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

// Inicializa la partida (primera mano). Setea scoreboard, meta y arranca ronda 1
// usando el doble 6 (o doble más alto disponible) para decidir quién empieza.
function initGame(room) {
  // En 2v2 el scoreboard guarda 2 entradas (Equipo A y Equipo B);
  // en modos individuales, una entrada por jugador.
  room.scoreboard = new Array(room.teams ? 2 : room.maxPlayers).fill(0);
  room.targetScore = 100;
  room.roundNumber = 0;
  room.log = [];
  room.readyPlayers = new Set();
  startRound(room, null);
}

// Arranca una mano. Si starterPlayer es null, usa doble 6 (primera mano);
// si no, ese jugador empieza con la ficha que quiera (ganador de mano previa).
function startRound(room, starterPlayer) {
  const { hands, boneyard } = game.deal(room.maxPlayers);
  for (let i = 0; i < room.maxPlayers; i++) {
    room.players[i].hand = hands[i];
  }
  room.boneyard = boneyard;

  let turn, starterTile;
  if (starterPlayer === null) {
    const s = game.findStarter(hands);
    turn = s.player;
    starterTile = s.tile;
  } else {
    turn = starterPlayer;
    starterTile = null;
  }

  room.status = 'playing';
  room.chain = [];
  room.turn = turn;
  room.consecutivePasses = 0;
  room.starterTile = starterTile;
  room.lastMove = null;
  room.roundNumber += 1;
  room.readyPlayers = new Set();
  if (room.roundEndTimer) {
    clearTimeout(room.roundEndTimer);
    room.roundEndTimer = null;
  }

  room.log.push(`— Mano ${room.roundNumber} —`);
  if (starterTile) {
    room.log.push(
      `Empieza ${room.players[turn].name} (tiene el ${starterTile[0]}|${starterTile[1]})`
    );
  } else {
    room.log.push(`Empieza ${room.players[turn].name} (ganó la mano anterior)`);
  }
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
  initGame,
  startRound,
};

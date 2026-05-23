// Servidor Express + Socket.IO. Sirve los archivos estáticos de /public
// y maneja los eventos del juego.

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const game = require('./game');
const roomsMod = require('./rooms');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const PORT = process.env.PORT || 3000;
const DISCONNECT_GRACE_MS = 60_000;
// Gracia más corta en sala de espera: cubre redirects (creador navegando de '/'
// a '/room/CODE') y reloads, sin dejar salas zombies por mucho tiempo.
const WAITING_GRACE_MS = 30_000;

// Servimos estáticos sin caché para evitar que el navegador siga sirviendo
// CSS/JS viejos después de un cambio. Trade-off: cada recarga pide los archivos
// de nuevo. Para una app de uso casual no impacta y simplifica iteración.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store');
  },
}));

// Una sola página: cliente único maneja todas las vistas. /room/:code
// permite enlaces compartibles; el cliente lee el código de la URL.
app.get('/room/:code', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ---- helpers de broadcast ----

// Resumen público de la sala (sin las manos de otros jugadores).
function publicRoomState(room) {
  return {
    code: room.code,
    status: room.status,
    players: room.players.map(p => ({
      name: p.name,
      connected: p.connected,
      tilesLeft: p.hand.length,
    })),
  };
}

// Estado público del juego (mesa, turno, conteos). No incluye manos.
function publicGameState(room) {
  const ends = game.getEnds(room.chain);
  return {
    code: room.code,
    status: room.status,
    chain: room.chain,
    ends,
    turn: room.turn,
    turnName: room.players[room.turn] ? room.players[room.turn].name : null,
    players: room.players.map(p => ({
      name: p.name,
      connected: p.connected,
      tilesLeft: p.hand.length,
    })),
    log: room.log,
  };
}

function emitRoomUpdate(room) {
  io.to(room.code).emit('room_update', publicRoomState(room));
}

function emitGameState(room) {
  io.to(room.code).emit('game_state', publicGameState(room));
  // Además, a cada jugador le mandamos su mano privada con info de jugadas válidas.
  const ends = game.getEnds(room.chain);
  for (const p of room.players) {
    if (!p.connected) continue;
    const handWithPlay = p.hand.map(t => ({
      tile: t,
      canPlay: game.canPlay(t, ends),
    }));
    io.to(p.socketId).emit('hand_update', {
      hand: handWithPlay,
      yourTurn: room.players[room.turn].socketId === p.socketId,
      canPass: !game.hasAnyPlay(p.hand, ends),
    });
  }
}

// Arranca la partida cuando hay 4 jugadores.
function beginGame(room) {
  roomsMod.startGame(room);
  const starterName = room.players[room.turn].name;
  room.log.push(`Empieza ${starterName} (tiene el ${room.starterTile[0]}|${room.starterTile[1]})`);

  // Estado inicial público.
  io.to(room.code).emit('game_started', publicGameState(room));
  // Mandamos manos privadas.
  emitGameState(room);
}

// ---- manejo de eventos ----

io.on('connection', (socket) => {

  socket.on('create_room', ({ name }) => {
    const cleanName = (name || '').toString().trim().slice(0, 20);
    if (!cleanName) {
      socket.emit('error_msg', { message: 'Nombre inválido' });
      return;
    }
    const room = roomsMod.createRoom(cleanName, socket.id);
    socket.join(room.code);
    socket.emit('room_joined', { code: room.code, yourName: cleanName });
    emitRoomUpdate(room);
  });

  socket.on('join_room', ({ code, name }) => {
    const cleanName = (name || '').toString().trim().slice(0, 20);
    const cleanCode = (code || '').toString().trim().toUpperCase();
    if (!cleanName || !cleanCode) {
      socket.emit('error_msg', { message: 'Nombre o código inválido' });
      return;
    }

    // Si hay un jugador con el mismo nombre marcado como conectado pero su
    // socket ya no existe (caso típico: el redirect del creador, donde el
    // disconnect del socket viejo aún no fue procesado), lo marcamos como
    // desconectado para que joinRoom lo trate como reconexión.
    const existingRoom = roomsMod.rooms.get(cleanCode);
    if (existingRoom) {
      const existing = existingRoom.players.find(
        p => p.name === cleanName && p.connected && p.socketId !== socket.id
      );
      if (existing) {
        const oldSocket = io.sockets.sockets.get(existing.socketId);
        if (!oldSocket || !oldSocket.connected) {
          existing.connected = false;
        }
      }
    }

    const result = roomsMod.joinRoom(cleanCode, cleanName, socket.id);
    if (result.error) {
      socket.emit('error_msg', { message: result.error });
      return;
    }
    socket.join(result.room.code);
    socket.emit('room_joined', { code: result.room.code, yourName: cleanName });
    emitRoomUpdate(result.room);

    if (result.reconnected) {
      // Avisamos a todos y reenviamos estado al reconectado.
      io.to(result.room.code).emit('player_reconnected', { name: cleanName });
      emitGameState(result.room);
    } else if (result.room.players.length === 4 && result.room.status === 'waiting') {
      // Arrancamos automáticamente.
      beginGame(result.room);
    }
  });

  socket.on('play_tile', ({ tile, end }) => {
    const room = roomsMod.getRoomBySocket(socket.id);
    if (!room || room.status !== 'playing') {
      socket.emit('invalid_move', { reason: 'No estás en una partida activa' });
      return;
    }
    const playerIdx = roomsMod.getPlayerIndex(room, socket.id);
    if (playerIdx !== room.turn) {
      socket.emit('invalid_move', { reason: 'No es tu turno' });
      return;
    }
    if (!Array.isArray(tile) || tile.length !== 2) {
      socket.emit('invalid_move', { reason: 'Ficha inválida' });
      return;
    }
    const player = room.players[playerIdx];

    // ¿La tiene en la mano?
    const has = player.hand.some(t =>
      (t[0] === tile[0] && t[1] === tile[1]) ||
      (t[0] === tile[1] && t[1] === tile[0])
    );
    if (!has) {
      socket.emit('invalid_move', { reason: 'No tienes esa ficha' });
      return;
    }

    const ends = game.getEnds(room.chain);
    // Si la mesa está vacía, el primer movimiento NO requiere extremo válido
    // (el jugador inicial coloca su ficha de apertura). Forzamos 'right'.
    let chosenEnd = end;
    if (room.chain.length === 0) chosenEnd = 'right';

    // Validamos que pueda jugar ahí.
    const canMap = game.canPlay(tile, ends);
    if (room.chain.length > 0 && !canMap[chosenEnd]) {
      socket.emit('invalid_move', { reason: 'La ficha no encaja en ese extremo' });
      return;
    }

    const placed = game.placeTile(room.chain, tile, chosenEnd);
    if (!placed) {
      socket.emit('invalid_move', { reason: 'No se pudo colocar la ficha' });
      return;
    }
    game.removeTile(player.hand, tile);
    room.consecutivePasses = 0;

    const sideTxt = room.chain.length === 1 ? 'en la mesa' :
      (chosenEnd === 'left' ? 'a la izquierda' : 'a la derecha');
    room.log.push(`${player.name} jugó [${placed[0]}|${placed[1]}] ${sideTxt}`);

    // ¿Terminó la partida?
    if (player.hand.length === 0) {
      const result = game.resolveEnd(
        room.players.map(p => p.hand),
        room.players.map(p => p.name)
      );
      room.status = 'finished';
      emitGameState(room);
      io.to(room.code).emit('game_over', {
        winner: result.winner,
        winnerName: room.players[result.winner].name,
        reason: result.reason,
        scores: result.scores,
      });
      return;
    }

    // Avanzamos turno.
    advanceTurn(room);
    emitGameState(room);
    checkBlocked(room);
  });

  socket.on('pass_turn', () => {
    const room = roomsMod.getRoomBySocket(socket.id);
    if (!room || room.status !== 'playing') {
      socket.emit('invalid_move', { reason: 'No estás en una partida activa' });
      return;
    }
    const playerIdx = roomsMod.getPlayerIndex(room, socket.id);
    if (playerIdx !== room.turn) {
      socket.emit('invalid_move', { reason: 'No es tu turno' });
      return;
    }
    const player = room.players[playerIdx];
    const ends = game.getEnds(room.chain);
    if (game.hasAnyPlay(player.hand, ends)) {
      socket.emit('invalid_move', { reason: 'Tienes jugadas válidas, no puedes pasar' });
      return;
    }
    room.log.push(`${player.name} pasó`);
    room.consecutivePasses += 1;
    advanceTurn(room);
    emitGameState(room);
    checkBlocked(room);
  });

  socket.on('disconnect', () => {
    const info = roomsMod.handleDisconnect(socket.id);
    if (!info) return;
    const room = info.room;
    if (!room) return;

    const disconnectedName = room.players[info.playerIdx].name;

    if (room.status === 'waiting') {
      // En espera: gracia corta para tolerar redirects y reloads. Si no vuelve,
      // liberamos el slot. Si la sala queda vacía, la borramos.
      emitRoomUpdate(room);
      const timer = setTimeout(() => {
        const idx = room.players.findIndex(p => p.name === disconnectedName);
        if (idx !== -1 && !room.players[idx].connected) {
          room.players.splice(idx, 1);
          if (room.players.length === 0) {
            roomsMod.deleteRoom(room.code);
          } else {
            emitRoomUpdate(room);
          }
        }
      }, WAITING_GRACE_MS);
      room.disconnectTimers.set(info.playerIdx, timer);
      return;
    }

    // Estaba jugando: notificamos a los demás y arrancamos timer de 60s.
    io.to(room.code).emit('player_disconnected', {
      name: disconnectedName,
      graceSeconds: DISCONNECT_GRACE_MS / 1000,
    });
    emitRoomUpdate(room);

    const timer = setTimeout(() => {
      if (room.players[info.playerIdx] && !room.players[info.playerIdx].connected) {
        room.status = 'cancelled';
        io.to(room.code).emit('game_over', {
          winner: null,
          winnerName: null,
          reason: 'cancelled',
          scores: [],
          message: `${disconnectedName} no volvió. Partida cancelada.`,
        });
        roomsMod.deleteRoom(room.code);
      }
    }, DISCONNECT_GRACE_MS);
    room.disconnectTimers.set(info.playerIdx, timer);
  });
});

// Avanza el turno saltando jugadores desconectados (por si reconectan).
// Nota: si todos están desconectados, no entra en bucle infinito porque la sala
// se habría cancelado antes.
function advanceTurn(room) {
  room.turn = (room.turn + 1) % 4;
}

// Detecta trancado: si todos pasaron en su última oportunidad o nadie tiene jugada.
function checkBlocked(room) {
  if (room.status !== 'playing') return;
  const ends = game.getEnds(room.chain);
  if (game.isBlocked(room.players.map(p => p.hand), ends)) {
    const result = game.resolveEnd(
      room.players.map(p => p.hand),
      room.players.map(p => p.name)
    );
    room.status = 'finished';
    io.to(room.code).emit('game_over', {
      winner: result.winner,
      winnerName: room.players[result.winner].name,
      reason: 'trancado',
      scores: result.scores,
    });
  }
}

server.listen(PORT, () => {
  console.log(`Servidor de dominó escuchando en http://localhost:${PORT}`);
});

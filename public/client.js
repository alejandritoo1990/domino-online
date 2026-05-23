// Cliente único de página única. Mantiene un solo socket durante toda la
// sesión y conmuta entre las cuatro vistas (lobby, waiting, game, over)
// sin recargar la página. La URL se actualiza con history.pushState para
// que los enlaces /room/CODE sigan siendo compartibles.

(function () {
  const socket = io();

  // ===== Referencias a elementos =====
  const views = {
    lobby:   document.getElementById('view-lobby'),
    waiting: document.getElementById('view-waiting'),
    game:    document.getElementById('view-game'),
    over:    document.getElementById('view-over'),
  };

  // Lobby
  const nameInput = document.getElementById('name');
  const codeInput = document.getElementById('code');
  const btnCreate = document.getElementById('btn-create');
  const btnJoin = document.getElementById('btn-join');
  const errorEl = document.getElementById('error');

  // Waiting
  const roomCodeEl = document.getElementById('room-code');
  const waitingPlayersEl = document.getElementById('waiting-players');

  // Game
  const gameCodeEl = document.getElementById('game-code');
  const turnIndicator = document.getElementById('turn-indicator');
  const playersListEl = document.getElementById('players-list');
  const chainEl = document.getElementById('table-chain');
  const endLeftEl = document.getElementById('end-left');
  const endRightEl = document.getElementById('end-right');
  const handEl = document.getElementById('hand');
  const btnPass = document.getElementById('btn-pass');
  const endSelector = document.getElementById('end-selector');
  const endSelectorTile = document.getElementById('end-selector-tile');
  const btnPlayLeft = document.getElementById('btn-play-left');
  const btnPlayRight = document.getElementById('btn-play-right');
  const btnCancelEnd = document.getElementById('btn-cancel-end');
  const logEl = document.getElementById('log');

  // Over
  const overTitle = document.getElementById('over-title');
  const overReason = document.getElementById('over-reason');
  const overScores = document.getElementById('over-scores');
  const btnHome = document.getElementById('btn-home');

  // Global
  const banner = document.getElementById('banner');

  // ===== Estado local =====
  let myName = '';
  let myCode = '';
  let lastHand = [];           // [{tile:[a,b], canPlay:{left,right}}]
  let yourTurn = false;
  let pendingTile = null;
  let bannerTimer = null;
  let hasJoined = false;       // ¿ya entramos a una sala en este socket?

  // ===== Utilidades =====
  function showView(name) {
    for (const k of Object.keys(views)) {
      views[k].classList.toggle('hidden', k !== name);
    }
  }

  function showBanner(msg, level = 'ok') {
    banner.textContent = msg;
    banner.className = 'banner ' + (level === 'err' ? 'err' : level === 'warn' ? 'warn' : '');
    banner.classList.remove('hidden');
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => banner.classList.add('hidden'), 4000);
  }

  function showError(msg) { if (errorEl) errorEl.textContent = msg; }
  function clearError()   { if (errorEl) errorEl.textContent = ''; }

  function tileTxt(t) { return `[${t[0]}|${t[1]}]`; }

  function setUrl(code) {
    const target = code ? `/room/${code}` : '/';
    if (window.location.pathname !== target) {
      window.history.pushState({}, '', target);
    }
  }

  // ===== Renderizado =====
  function renderChain(chain, ends) {
    chainEl.innerHTML = '';
    if (chain.length === 0) {
      chainEl.textContent = '(mesa vacía)';
    } else {
      chain.forEach((t, i) => {
        const span = document.createElement('span');
        span.className = 'tile' + (t[0] === t[1] ? ' tile-double' : '');
        span.textContent = tileTxt(t);
        chainEl.appendChild(span);
        if (i < chain.length - 1) {
          const sep = document.createElement('span');
          sep.textContent = '-';
          chainEl.appendChild(sep);
        }
      });
    }
    endLeftEl.textContent = ends.left === null ? '-' : ends.left;
    endRightEl.textContent = ends.right === null ? '-' : ends.right;
  }

  function renderPlayers(players, turnIdx) {
    playersListEl.innerHTML = '';
    players.forEach((p, i) => {
      const li = document.createElement('li');
      const youMark = p.name === myName ? ' (tú)' : '';
      li.textContent = `${p.name}${youMark} — ${p.tilesLeft} fichas`;
      if (i === turnIdx) li.classList.add('current-turn');
      if (!p.connected) li.classList.add('disconnected');
      if (p.name === myName) li.classList.add('you');
      playersListEl.appendChild(li);
    });
  }

  function renderHand() {
    handEl.innerHTML = '';
    if (!lastHand.length) {
      handEl.textContent = '(sin fichas)';
      return;
    }
    lastHand.forEach((entry) => {
      const t = entry.tile;
      const btn = document.createElement('button');
      btn.className = 'tile-btn';
      btn.textContent = tileTxt(t);
      const playable = yourTurn && (entry.canPlay.left || entry.canPlay.right);
      btn.disabled = !playable;
      if (playable) btn.classList.add('playable');

      btn.addEventListener('click', () => {
        if (entry.canPlay.left && entry.canPlay.right) {
          openEndSelector(t);
        } else if (entry.canPlay.left) {
          socket.emit('play_tile', { tile: t, end: 'left' });
        } else if (entry.canPlay.right) {
          socket.emit('play_tile', { tile: t, end: 'right' });
        }
      });
      handEl.appendChild(btn);
    });
  }

  function renderLog(log) {
    logEl.innerHTML = '';
    for (let i = log.length - 1; i >= 0; i--) {
      const li = document.createElement('li');
      li.textContent = log[i];
      logEl.appendChild(li);
    }
  }

  function updateTurnIndicator(turnIdx, players) {
    if (yourTurn) {
      turnIndicator.textContent = 'TU TURNO';
      turnIndicator.classList.add('your-turn');
    } else {
      turnIndicator.textContent = `Turno de ${players[turnIdx].name}`;
      turnIndicator.classList.remove('your-turn');
    }
  }

  function openEndSelector(tile) {
    pendingTile = tile;
    endSelectorTile.textContent = tileTxt(tile);
    endSelector.classList.remove('hidden');
  }
  function closeEndSelector() {
    pendingTile = null;
    endSelector.classList.add('hidden');
  }

  // ===== Inicialización =====
  // Si la URL es /room/CODE precargamos el código en el input. El usuario
  // debe ingresar su nombre y darle "Unirse" — no hacemos auto-join porque
  // si recarga la página, su socket es nuevo y no sabe quién es.
  const pathMatch = window.location.pathname.match(/^\/room\/([A-Z0-9]+)/i);
  if (pathMatch) {
    codeInput.value = pathMatch[1].toUpperCase();
  }

  // ===== Acciones del lobby =====
  btnCreate.addEventListener('click', () => {
    clearError();
    const name = nameInput.value.trim();
    if (!name) { showError('Ingresa tu nombre'); return; }
    myName = name;
    btnCreate.disabled = true;
    btnJoin.disabled = true;
    socket.emit('create_room', { name });
  });

  btnJoin.addEventListener('click', () => {
    clearError();
    const name = nameInput.value.trim();
    const code = codeInput.value.trim().toUpperCase();
    if (!name) { showError('Ingresa tu nombre'); return; }
    if (!code) { showError('Ingresa el código de la sala'); return; }
    myName = name;
    myCode = code;
    btnCreate.disabled = true;
    btnJoin.disabled = true;
    socket.emit('join_room', { name, code });
  });

  // ===== Acciones del juego =====
  btnPlayLeft.addEventListener('click', () => {
    if (!pendingTile) return;
    socket.emit('play_tile', { tile: pendingTile, end: 'left' });
    closeEndSelector();
  });
  btnPlayRight.addEventListener('click', () => {
    if (!pendingTile) return;
    socket.emit('play_tile', { tile: pendingTile, end: 'right' });
    closeEndSelector();
  });
  btnCancelEnd.addEventListener('click', closeEndSelector);

  btnPass.addEventListener('click', () => {
    socket.emit('pass_turn');
  });

  btnHome.addEventListener('click', () => {
    // Recargamos para empezar limpio.
    window.location.href = '/';
  });

  // ===== Eventos socket =====
  socket.on('room_joined', ({ code, yourName }) => {
    myCode = code;
    myName = yourName;
    hasJoined = true;
    roomCodeEl.textContent = code;
    gameCodeEl.textContent = code;
    setUrl(code);
    showView('waiting');
  });

  socket.on('room_update', (state) => {
    roomCodeEl.textContent = state.code;
    gameCodeEl.textContent = state.code;
    // Si seguimos en lobby por algún motivo (caso raro), saltamos a waiting.
    if (state.status === 'waiting' && hasJoined) {
      // Actualizar lista de jugadores en sala de espera.
      waitingPlayersEl.innerHTML = '';
      state.players.forEach((p) => {
        const li = document.createElement('li');
        li.textContent = `${p.name}${p.name === myName ? ' (tú)' : ''}`;
        if (p.name === myName) li.classList.add('you');
        if (!p.connected) li.classList.add('disconnected');
        waitingPlayersEl.appendChild(li);
      });
      for (let i = state.players.length; i < 4; i++) {
        const li = document.createElement('li');
        li.textContent = '(esperando...)';
        li.style.opacity = '0.5';
        waitingPlayersEl.appendChild(li);
      }
      // No forzamos showView('waiting') aquí si ya estamos en game.
      if (views.over.classList.contains('hidden') &&
          views.game.classList.contains('hidden')) {
        showView('waiting');
      }
    }
  });

  socket.on('game_started', (state) => {
    showView('game');
    renderChain(state.chain, state.ends);
    renderPlayers(state.players, state.turn);
    renderLog(state.log);
    updateTurnIndicator(state.turn, state.players);
    showBanner('¡Empieza la partida!');
  });

  socket.on('game_state', (state) => {
    if (views.game.classList.contains('hidden') &&
        views.over.classList.contains('hidden')) {
      showView('game');
    }
    renderChain(state.chain, state.ends);
    renderPlayers(state.players, state.turn);
    renderLog(state.log);
    updateTurnIndicator(state.turn, state.players);
  });

  socket.on('hand_update', ({ hand, yourTurn: yt, canPass }) => {
    lastHand = hand;
    yourTurn = yt;
    btnPass.disabled = !(yt && canPass);
    if (!yt) closeEndSelector();
    renderHand();
    if (yt) {
      turnIndicator.textContent = 'TU TURNO';
      turnIndicator.classList.add('your-turn');
    }
  });

  socket.on('invalid_move', ({ reason }) => {
    showBanner('Jugada inválida: ' + reason, 'err');
    closeEndSelector();
  });

  socket.on('player_disconnected', ({ name, graceSeconds }) => {
    showBanner(`${name} se desconectó. Esperando hasta ${graceSeconds}s...`, 'warn');
  });

  socket.on('player_reconnected', ({ name }) => {
    if (name !== myName) {
      showBanner(`${name} se reconectó`, 'ok');
    }
  });

  socket.on('game_over', (data) => {
    showView('over');
    if (data.reason === 'cancelled') {
      overTitle.textContent = 'Partida cancelada';
      overReason.textContent = data.message || 'Un jugador no volvió a tiempo.';
      overScores.innerHTML = '';
      return;
    }
    overTitle.textContent = data.winnerName === myName
      ? '¡Ganaste!'
      : `Ganó ${data.winnerName}`;
    overReason.textContent = data.reason === 'domino'
      ? 'Se quedó sin fichas (¡dominó!)'
      : 'Trancado — menor cantidad de puntos en mano';
    overScores.innerHTML = '';
    const sorted = [...data.scores].sort((a, b) => a.points - b.points);
    sorted.forEach((s) => {
      const li = document.createElement('li');
      const youMark = s.name === myName ? ' (tú)' : '';
      const winMark = s.player === data.winner ? '  (ganador)' : '';
      li.textContent = `${s.name}${youMark} — ${s.points} pts (${s.tilesLeft} fichas)${winMark}`;
      overScores.appendChild(li);
    });
  });

  socket.on('error_msg', ({ message }) => {
    // Si todavía no entramos a una sala, mostramos el error en el lobby.
    if (!hasJoined) {
      showError(message);
      btnCreate.disabled = false;
      btnJoin.disabled = false;
      return;
    }
    showBanner(message, 'err');
  });

  socket.on('disconnect', () => {
    showBanner('Conexión perdida — intentando reconectar...', 'warn');
  });

  socket.on('connect', () => {
    // En reconexiones automáticas de socket.io (no en la primera conexión),
    // si ya estábamos en una sala, intentamos volver con el mismo nombre+código.
    if (hasJoined && myName && myCode) {
      socket.emit('join_room', { name: myName, code: myCode });
    }
  });
})();

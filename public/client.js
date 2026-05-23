// Cliente único de página única. Mantiene un solo socket durante toda la
// sesión y conmuta entre las cuatro vistas (lobby, waiting, game, over)
// sin recargar la página. La URL se actualiza con history.pushState para
// que los enlaces /room/CODE sigan siendo compartibles.

(function () {
  const socket = io();

  // ===== Referencias a elementos =====
  const views = {
    lobby:           document.getElementById('view-lobby'),
    waiting:         document.getElementById('view-waiting'),
    game:            document.getElementById('view-game'),
    'round-summary': document.getElementById('view-round-summary'),
    over:            document.getElementById('view-over'),
  };

  // Lobby
  const nameInput = document.getElementById('name');
  const codeInput = document.getElementById('code');
  const modeSelect = document.getElementById('mode');
  const btnCreate = document.getElementById('btn-create');
  const btnJoin = document.getElementById('btn-join');
  const errorEl = document.getElementById('error');

  // Waiting
  const roomCodeEl = document.getElementById('room-code');
  const waitingPlayersEl = document.getElementById('waiting-players');

  // Game
  const roundNumberEl = document.getElementById('round-number');
  const targetScoreEl = document.getElementById('target-score');
  const gameCodeEl = document.getElementById('game-code');
  const turnIndicator = document.getElementById('turn-indicator');
  const playersListEl = document.getElementById('players-list');
  const chainEl = document.getElementById('table-chain');
  const endLeftEl = document.getElementById('end-left');
  const endRightEl = document.getElementById('end-right');
  const handEl = document.getElementById('hand');
  const btnPass = document.getElementById('btn-pass');
  const btnDraw = document.getElementById('btn-draw');
  const boneyardInfo = document.getElementById('boneyard-info');
  const boneyardCountEl = document.getElementById('boneyard-count');
  const endSelector = document.getElementById('end-selector');
  const endSelectorTile = document.getElementById('end-selector-tile');
  const btnPlayLeft = document.getElementById('btn-play-left');
  const btnPlayRight = document.getElementById('btn-play-right');
  const btnCancelEnd = document.getElementById('btn-cancel-end');
  const logEl = document.getElementById('log');

  // Round summary
  const rsTitle = document.getElementById('rs-title');
  const rsReason = document.getElementById('rs-reason');
  const rsPoints = document.getElementById('rs-points');
  const rsScoreboard = document.getElementById('rs-scoreboard');
  const btnReady = document.getElementById('btn-ready');
  const rsCountdown = document.getElementById('rs-countdown');

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
  let countdownTimer = null;
  let countdownDeadline = 0;
  let targetScore = 100;
  let maxPlayers = 4;

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

  // Posiciones de los dots dentro de una mitad (grid 3x3, celdas numeradas 1..9).
  const DOT_POSITIONS = {
    0: [],
    1: [5],
    2: [1, 9],
    3: [1, 5, 9],
    4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9],
    6: [1, 3, 4, 6, 7, 9],
  };

  // Crea una mitad de ficha con sus dots.
  function makeHalf(value) {
    const half = document.createElement('div');
    half.className = 'domino-half';
    for (const pos of DOT_POSITIONS[value] || []) {
      const row = Math.ceil(pos / 3);
      const col = ((pos - 1) % 3) + 1;
      const dot = document.createElement('div');
      dot.className = 'dot';
      dot.style.gridRow = row;
      dot.style.gridColumn = col;
      half.appendChild(dot);
    }
    return half;
  }

  // Crea un elemento de ficha visual (no clickeable). orientation: 'h' | 'v'.
  // Los dobles en orientación horizontal se renderizan perpendiculares (clase
  // 'double'), como en el dominó real.
  function makeTileEl(tile, orientation) {
    const el = document.createElement('div');
    let cls = 'domino ' + orientation;
    if (orientation === 'h' && tile[0] === tile[1]) cls += ' double';
    el.className = cls;
    el.appendChild(makeHalf(tile[0]));
    el.appendChild(makeHalf(tile[1]));
    el.setAttribute('aria-label', tileTxt(tile));
    return el;
  }

  // Crea un botón clickeable con la anatomía de una ficha vertical (para la mano).
  function makeTileButton(tile) {
    const btn = document.createElement('button');
    btn.className = 'tile-btn';
    btn.appendChild(makeHalf(tile[0]));
    btn.appendChild(makeHalf(tile[1]));
    btn.setAttribute('aria-label', tileTxt(tile));
    btn.title = tileTxt(tile);
    return btn;
  }

  function setUrl(code) {
    const target = code ? `/room/${code}` : '/';
    if (window.location.pathname !== target) {
      window.history.pushState({}, '', target);
    }
  }

  // ===== Renderizado =====
  function renderChain(chain, ends, lastMove) {
    chainEl.innerHTML = '';
    chain.forEach((t, i) => {
      const el = makeTileEl(t, 'h');
      if (lastMove && lastMove.index === i) {
        el.classList.add('last-played');
      }
      chainEl.appendChild(el);
    });
    endLeftEl.textContent = ends.left === null ? '-' : ends.left;
    endRightEl.textContent = ends.right === null ? '-' : ends.right;
  }

  function renderPlayers(players, turnIdx) {
    playersListEl.innerHTML = '';
    players.forEach((p, i) => {
      const li = document.createElement('li');
      const youMark = p.name === myName ? ' (tú)' : '';
      const scoreTxt = (p.score !== undefined) ? ` · ${p.score} pts` : '';
      li.textContent = `${p.name}${youMark} — ${p.tilesLeft} fichas${scoreTxt}`;
      if (i === turnIdx) li.classList.add('current-turn');
      if (!p.connected) li.classList.add('disconnected');
      if (p.name === myName) li.classList.add('you');
      playersListEl.appendChild(li);
    });
  }

  // Renderiza un scoreboard (lista de jugadores con barra de progreso a la meta).
  // mark: índice del ganador a destacar, o -1.
  function renderScoreboard(container, players, scoreboard, mark, target) {
    container.innerHTML = '';
    scoreboard.forEach((score, i) => {
      const li = document.createElement('li');
      const name = players[i] || `Jugador ${i + 1}`;
      const youMark = name === myName ? ' (tú)' : '';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'sb-name';
      nameSpan.textContent = name + youMark;
      const scoreSpan = document.createElement('span');
      scoreSpan.className = 'sb-score';
      scoreSpan.textContent = score + ' / ' + target;
      li.appendChild(nameSpan);
      li.appendChild(scoreSpan);

      const bar = document.createElement('div');
      bar.className = 'sb-bar';
      const fill = document.createElement('div');
      fill.className = 'sb-bar-fill';
      fill.style.width = Math.min(100, (score / target) * 100) + '%';
      bar.appendChild(fill);
      li.appendChild(bar);

      if (i === mark) li.classList.add('winner-mark');
      if (name === myName) li.classList.add('you');
      container.appendChild(li);
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
      const btn = makeTileButton(t);
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
    endSelectorTile.innerHTML = '';
    endSelectorTile.appendChild(makeTileEl(tile, 'h'));
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
    const mode = (modeSelect && modeSelect.value === '2p') ? '2p' : '4p';
    btnCreate.disabled = true;
    btnJoin.disabled = true;
    socket.emit('create_room', { name, mode });
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

  btnDraw.addEventListener('click', () => {
    socket.emit('draw_tile');
  });

  btnHome.addEventListener('click', () => {
    // Recargamos para empezar limpio.
    window.location.href = '/';
  });

  btnReady.addEventListener('click', () => {
    socket.emit('ready_for_next_round');
    btnReady.disabled = true;
    btnReady.textContent = 'Esperando...';
  });

  function startCountdown(seconds) {
    stopCountdown();
    countdownDeadline = Date.now() + seconds * 1000;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((countdownDeadline - Date.now()) / 1000));
      rsCountdown.textContent = remaining > 0
        ? `Próxima mano en ${remaining}s...`
        : 'Empezando...';
      if (remaining <= 0) stopCountdown();
    };
    tick();
    countdownTimer = setInterval(tick, 500);
  }
  function stopCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    rsCountdown.textContent = '';
  }

  // ===== Eventos socket =====
  socket.on('room_joined', ({ code, yourName, maxPlayers: mp }) => {
    myCode = code;
    myName = yourName;
    hasJoined = true;
    if (mp) maxPlayers = mp;
    roomCodeEl.textContent = code;
    gameCodeEl.textContent = code;
    setUrl(code);
    showView('waiting');
  });

  socket.on('room_update', (state) => {
    roomCodeEl.textContent = state.code;
    gameCodeEl.textContent = state.code;
    if (state.maxPlayers) maxPlayers = state.maxPlayers;
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
      const slots = state.maxPlayers || maxPlayers;
      for (let i = state.players.length; i < slots; i++) {
        const li = document.createElement('li');
        li.textContent = '(esperando...)';
        li.style.opacity = '0.5';
        waitingPlayersEl.appendChild(li);
      }
      // No forzamos showView('waiting') si ya estamos en game/round-summary/over.
      if (views.over.classList.contains('hidden') &&
          views.game.classList.contains('hidden') &&
          views['round-summary'].classList.contains('hidden')) {
        showView('waiting');
      }
    }
  });

  function applyGameState(state) {
    renderChain(state.chain, state.ends, state.lastMove);
    renderPlayers(state.players, state.turn);
    renderLog(state.log);
    updateTurnIndicator(state.turn, state.players);
    if (state.roundNumber) roundNumberEl.textContent = state.roundNumber;
    if (state.targetScore) {
      targetScoreEl.textContent = state.targetScore;
      targetScore = state.targetScore;
    }
    // Pozo visible solo si hay (modo 2p mientras quedan fichas)
    if (state.boneyardCount && state.boneyardCount > 0) {
      boneyardInfo.classList.remove('hidden');
      boneyardCountEl.textContent = state.boneyardCount;
    } else {
      boneyardInfo.classList.add('hidden');
    }
  }

  socket.on('game_started', (state) => {
    showView('game');
    applyGameState(state);
    showBanner('¡Empieza la partida!');
  });

  socket.on('round_started', (state) => {
    stopCountdown();
    showView('game');
    applyGameState(state);
    showBanner(`Mano ${state.roundNumber} — ¡a jugar!`);
  });

  socket.on('game_state', (state) => {
    if (views.game.classList.contains('hidden') &&
        views.over.classList.contains('hidden') &&
        views['round-summary'].classList.contains('hidden')) {
      showView('game');
    }
    applyGameState(state);
  });

  socket.on('hand_update', ({ hand, yourTurn: yt, canPass, canDraw }) => {
    lastHand = hand;
    yourTurn = yt;
    // Si se puede robar (hay pozo), mostramos botón Robar y ocultamos Pasar.
    // Cuando se agota el pozo, mostramos Pasar.
    if (canDraw) {
      btnDraw.classList.remove('hidden');
      btnDraw.disabled = !yt;
      btnPass.classList.add('hidden');
    } else {
      btnDraw.classList.add('hidden');
      btnPass.classList.remove('hidden');
      btnPass.disabled = !(yt && canPass);
    }
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

  // Resumen de una mano (no es fin de partida).
  socket.on('round_summary', (data) => {
    closeEndSelector();
    yourTurn = false;
    showView('round-summary');
    rsTitle.textContent = data.winnerName === myName
      ? `¡Ganaste la mano ${data.roundNumber}!`
      : `Mano ${data.roundNumber}: ganó ${data.winnerName}`;
    rsReason.textContent = data.reason === 'domino'
      ? 'Se quedó sin fichas (dominó)'
      : 'Trancado — menor cantidad de puntos en mano';
    rsPoints.textContent = `+${data.pointsAwarded} puntos a ${data.winnerName}`;
    renderScoreboard(rsScoreboard, data.players, data.scoreboard, data.winner, data.targetScore);
    btnReady.disabled = false;
    btnReady.textContent = 'Listo para la siguiente mano';
    startCountdown(15);
  });

  socket.on('ready_update', ({ ready }) => {
    btnReady.textContent = `Listo (${ready.length}/${maxPlayers})`;
  });

  // Fin de partida real: alguien alcanzó la meta.
  socket.on('match_over', (data) => {
    stopCountdown();
    showView('over');
    overTitle.textContent = data.winnerName === myName
      ? '¡Ganaste la partida!'
      : `Ganó la partida: ${data.winnerName}`;
    overReason.textContent = `${data.winnerName} alcanzó ${data.scoreboard[data.winner]} puntos en ${data.roundNumber} manos`;
    renderScoreboard(overScores, data.players, data.scoreboard, data.winner, data.targetScore);
  });

  // game_over solo llega ahora cuando la partida se cancela (desconexión).
  socket.on('game_over', (data) => {
    stopCountdown();
    showView('over');
    if (data.reason === 'cancelled') {
      overTitle.textContent = 'Partida cancelada';
      overReason.textContent = data.message || 'Un jugador no volvió a tiempo.';
      overScores.innerHTML = '';
    }
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

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
  const btnCopyCode = document.getElementById('btn-copy-code');
  const btnCopyLink = document.getElementById('btn-copy-link');
  const btnLeaveWaiting = document.getElementById('btn-leave-waiting');

  // Game
  const roundNumberEl = document.getElementById('round-number');
  const targetScoreEl = document.getElementById('target-score');
  const gameCodeEl = document.getElementById('game-code');
  const btnCopyCodeGame = document.getElementById('btn-copy-code-game');
  const btnLeaveGame = document.getElementById('btn-leave-game');
  const turnIndicator = document.getElementById('turn-indicator');
  const chainEl = document.getElementById('table-chain');
  const endLeftEl = document.getElementById('end-left');
  const endRightEl = document.getElementById('end-right');
  const seatTopEl = document.getElementById('seat-top');
  const seatLeftEl = document.getElementById('seat-left');
  const seatRightEl = document.getElementById('seat-right');
  const seatBottomEl = document.getElementById('seat-bottom');
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
  let pendingTile = null;       // ficha clickeada esperando elección de extremo
  let choosingEnd = false;      // estamos en modo "click izq o der en la mesa"
  let bannerTimer = null;
  let hasJoined = false;       // ¿ya entramos a una sala en este socket?
  let countdownTimer = null;
  let countdownDeadline = 0;
  let targetScore = 100;
  let maxPlayers = 4;
  let teamsMode = false;

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

  // Crea un elemento clickeable con la anatomía de una ficha vertical (para
  // la mano). Usamos un div (no un <button>) para evitar estilos por defecto
  // del navegador en móvil (iOS Safari pintaba el fondo de verde sobre los
  // dobles blancos).
  function makeTileButton(tile) {
    const btn = document.createElement('div');
    btn.className = 'tile-btn';
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.appendChild(makeHalf(tile[0]));
    btn.appendChild(makeHalf(tile[1]));
    btn.setAttribute('aria-label', tileTxt(tile));
    btn.title = tileTxt(tile);
    // Polyfill de "disabled" para div: lo expongo como propiedad.
    Object.defineProperty(btn, 'disabled', {
      get() { return btn.classList.contains('disabled'); },
      set(v) { btn.classList.toggle('disabled', !!v); },
      configurable: true,
    });
    return btn;
  }

  function setUrl(code) {
    const target = code ? `/room/${code}` : '/';
    if (window.location.pathname !== target) {
      window.history.pushState({}, '', target);
    }
  }

  // ===== Renderizado =====
  // Devuelve las dimensiones de fichas según viewport actual.
  // VW/VH = HW/HH rotadas 90° para que las cornerizadas conecten exactas.
  function getTileDims() {
    const w = window.innerWidth;
    if (w <= 380) return { HW: 44, HH: 22, VW: 22, VH: 44, gap: 1 };
    if (w <= 500) return { HW: 52, HH: 26, VW: 26, VH: 52, gap: 1 };
    if (w <= 700) return { HW: 60, HH: 30, VW: 30, VH: 60, gap: 1 };
    return                 { HW: 80, HH: 40, VW: 40, VH: 80, gap: 1 };
  }

  let lastChainData = null;
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (!lastChainData) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      renderChain(lastChainData.chain, lastChainData.ends, lastChainData.lastMove);
    }, 150);
  });

  // Crea un wrapper con la ficha dentro, listo para colgar del DOM.
  function createTileWrap(tile, orientation, idx, lastMove) {
    const tileEl = makeTileEl(tile, orientation);
    if (lastMove && lastMove.index === idx) tileEl.classList.add('last-played');
    const wrap = document.createElement('div');
    wrap.className = 'tile-wrap';
    wrap.appendChild(tileEl);
    return wrap;
  }

  // Renderiza la cadena con posicionamiento absoluto y cálculo pixel a pixel.
  // Cada ficha se ubica precisamente al lado de la anterior, las cornerizadas
  // se anclan al extremo real de la última ficha (no a un trackWidth genérico),
  // los dobles se pegan correctamente en las esquinas. Las filas que van en
  // dirección inversa tienen sus fichas rotadas 180° para que los pips conecten.
  function renderChain(chain, ends, lastMove) {
    lastChainData = { chain, ends, lastMove };
    chainEl.innerHTML = '';

    const { HW, HH, VW, VH, gap } = getTileDims();
    const padding = 14;
    const chainW = chainEl.clientWidth || 800;
    const chainH = chainEl.clientHeight || 460;
    const maxX = chainW - padding;
    const minBoundX = padding;
    // Offset vertical para que los dobles centrados (que se extienden VH/2
    // arriba y abajo de la línea media de la fila) entren sin recortarse.
    const dobleHalfExtra = (VH - HH) / 2;

    // Calcular posiciones de cada ficha.
    const positions = [];
    let curX = padding;
    let curY = padding + dobleHalfExtra;  // línea media de la fila a padding + VH/2
    let dir = 'right';
    let justAfterCorner = false;

    for (let i = 0; i < chain.length; i++) {
      const tile = chain[i];
      const isDouble = tile[0] === tile[1];

      let tw, th, orient;
      if (isDouble) {
        tw = VW; th = VH; orient = 'h-double';
      } else {
        tw = HW; th = HH; orient = 'h';
      }

      // ¿Esta ficha provocaría overflow → debe convertirse en corner V?
      let overflow = false;
      if (dir === 'right' && curX + tw > maxX) overflow = true;
      if (dir === 'left'  && curX - tw < minBoundX) overflow = true;

      if (overflow) {
        // Corner vertical (perpendicular), pegada al bottom real de la última
        // ficha. Aunque la corner sea un doble, NO ponemos una vertical extra
        // debajo: la siguiente ficha arranca directo la nueva fila horizontal.
        tw = VW; th = VH; orient = 'v';
        const lastP = positions[positions.length - 1];
        let vx, vy;
        if (dir === 'right') {
          vx = lastP.x + lastP.tw - VW;
        } else {
          vx = lastP.x;
        }
        vy = lastP.y + lastP.th;
        positions.push({ tile, x: vx, y: vy, tw, th, orient, idx: i, flipped: false });

        const newDir = (dir === 'right') ? 'left' : 'right';
        curY = vy + VH;
        if (newDir === 'right') curX = vx;
        else                    curX = vx + VW;
        dir = newDir;
        justAfterCorner = true;
        continue;
      }

      // Centramos los dobles del MEDIO de la fila sobre la línea media (para
      // que la "línea del centro" del doble caiga al nivel del pip que toca).
      // Excepción: la primera ficha tras una corner se mantiene al borde
      // superior de la fila, para apilarse directo bajo la corner V sin gap.
      let tileY = curY;
      if (orient === 'h-double' && !justAfterCorner) {
        tileY = curY - dobleHalfExtra;  // mueve el doble 20px hacia arriba
      }

      const tileX = (dir === 'right') ? curX : (curX - tw);
      const flipped = (dir === 'left');
      positions.push({ tile, x: tileX, y: tileY, tw, th, orient, idx: i, flipped });

      if (dir === 'right') curX += tw + gap;
      else                 curX -= tw + gap;
      justAfterCorner = false;
    }

    // Centrar la cadena (bounding box) en la mesa horizontal y verticalmente.
    if (positions.length > 0) {
      let bbMinX = Infinity, bbMaxX = -Infinity;
      let bbMinY = Infinity, bbMaxY = -Infinity;
      positions.forEach(p => {
        bbMinX = Math.min(bbMinX, p.x);
        bbMaxX = Math.max(bbMaxX, p.x + p.tw);
        bbMinY = Math.min(bbMinY, p.y);
        bbMaxY = Math.max(bbMaxY, p.y + p.th);
      });
      const bbW = bbMaxX - bbMinX;
      const bbH = bbMaxY - bbMinY;
      // No empujamos fuera del padding si la cadena no cabe centrada.
      const offsetX = Math.max(padding - bbMinX, (chainW - bbW) / 2 - bbMinX);
      const offsetY = Math.max(padding - bbMinY, (chainH - bbH) / 2 - bbMinY);
      positions.forEach(p => { p.x += offsetX; p.y += offsetY; });
    }

    // Renderizar cada ficha como absolutely-positioned.
    positions.forEach(p => {
      const wrap = document.createElement('div');
      wrap.className = 'tile-abs' + (p.flipped ? ' flipped' : '');
      wrap.style.left = p.x + 'px';
      wrap.style.top  = p.y + 'px';

      const orientForMake = (p.orient === 'v') ? 'v' : 'h';
      const tileEl = makeTileEl(p.tile, orientForMake);
      if (lastMove && lastMove.index === p.idx) tileEl.classList.add('last-played');
      wrap.appendChild(tileEl);
      chainEl.appendChild(wrap);
    });

    // Si estamos eligiendo extremo, resaltar las puntas de la cadena.
    if (choosingEnd && positions.length > 0) {
      if (positions.length === 1) {
        // Con una sola ficha en la mesa, los dos extremos están en la misma
        // ficha. Mostramos los targets a los COSTADOS (izquierda y derecha)
        // para que el usuario pueda elegir claramente.
        addEndTargetSide(positions[0], 'left');
        addEndTargetSide(positions[0], 'right');
      } else {
        addEndTarget(positions[0], 'left');
        addEndTarget(positions[positions.length - 1], 'right');
      }
    }

    if (endLeftEl) endLeftEl.textContent = ends.left === null ? '-' : ends.left;
    if (endRightEl) endRightEl.textContent = ends.right === null ? '-' : ends.right;
  }

  function emitPlayWithEnd(end) {
    if (!pendingTile) { cancelChooseEnd(); return; }
    socket.emit('play_tile', { tile: pendingTile, end });
    cancelChooseEnd();
  }

  function addEndTarget(pos, end) {
    const overlay = document.createElement('div');
    overlay.className = 'end-target';
    overlay.dataset.end = end;
    const pad = 8;
    overlay.style.left = (pos.x - pad) + 'px';
    overlay.style.top  = (pos.y - pad) + 'px';
    overlay.style.width  = (pos.tw + 2 * pad) + 'px';
    overlay.style.height = (pos.th + 2 * pad) + 'px';
    overlay.addEventListener('click', (e) => {
      e.stopPropagation();
      emitPlayWithEnd(end);
    });
    chainEl.appendChild(overlay);
  }

  // Target colocado AL LADO de la ficha (a la izquierda o a la derecha),
  // útil cuando la cadena tiene una sola ficha y los dos extremos coinciden.
  function addEndTargetSide(pos, end) {
    const overlay = document.createElement('div');
    overlay.className = 'end-target';
    overlay.dataset.end = end;
    const targetW = Math.max(60, pos.tw);
    const margin = 6;
    const pad = 8;
    if (end === 'left') {
      overlay.style.left = (pos.x - targetW - margin) + 'px';
    } else {
      overlay.style.left = (pos.x + pos.tw + margin) + 'px';
    }
    overlay.style.top = (pos.y - pad) + 'px';
    overlay.style.width = targetW + 'px';
    overlay.style.height = (pos.th + 2 * pad) + 'px';
    overlay.addEventListener('click', (e) => {
      e.stopPropagation();
      emitPlayWithEnd(end);
    });
    chainEl.appendChild(overlay);
  }

  function cancelChooseEnd() {
    choosingEnd = false;
    pendingTile = null;
    if (lastChainData) {
      renderChain(lastChainData.chain, lastChainData.ends, lastChainData.lastMove);
    }
  }

  // Construye un chip con info del jugador: nombre + badge con número de
  // fichas restantes. Los puntos NO se muestran en el chip durante la
  // partida — se ven en el resumen de mano y en el scoreboard final.
  function buildPlayerChip(p, i, turnIdx) {
    const chip = document.createElement('div');
    chip.className = 'player-chip';
    const isMe = p.name === myName;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'pc-name';
    nameSpan.textContent = p.name + (isMe ? ' (tú)' : '');
    chip.appendChild(nameSpan);

    const badge = document.createElement('span');
    badge.className = 'pc-badge';
    badge.textContent = p.tilesLeft;
    badge.title = `${p.tilesLeft} fichas`;
    chip.appendChild(badge);

    if (i === turnIdx) chip.classList.add('current-turn');
    if (!p.connected) chip.classList.add('disconnected');
    if (isMe) chip.classList.add('you');
    if (teamsMode) chip.classList.add(i % 2 === 0 ? 'team-a' : 'team-b');
    return chip;
  }

  // Coloca a cada jugador en un asiento alrededor de la mesa:
  //  - YO siempre en BOTTOM
  //  - +1 (siguiente en turno) → LEFT
  //  - +2 (cruzando la mesa)  → TOP (partner en 2v2)
  //  - +3                      → RIGHT
  // En modo 2p, solo BOTTOM (yo) y TOP (oponente).
  function renderPlayers(players, turnIdx) {
    [seatTopEl, seatLeftEl, seatRightEl, seatBottomEl].forEach(el => {
      if (el) el.innerHTML = '';
    });
    const N = players.length;
    if (N === 0) return;
    const myIdx = players.findIndex(p => p.name === myName);
    if (myIdx === -1) {
      // Fallback (no debería pasar): pongo todos en seat-top.
      players.forEach((p, i) => {
        if (seatTopEl) seatTopEl.appendChild(buildPlayerChip(p, i, turnIdx));
      });
      return;
    }

    players.forEach((p, i) => {
      const offset = ((i - myIdx) + N) % N;
      let target = null;
      if (N === 2) {
        target = (offset === 0) ? seatBottomEl : seatTopEl;
      } else {
        const seats = [seatBottomEl, seatLeftEl, seatTopEl, seatRightEl];
        target = seats[offset] || null;
      }
      if (!target) return;
      target.appendChild(buildPlayerChip(p, i, turnIdx));
    });
  }

  // Renderiza un scoreboard (lista con barra de progreso a la meta).
  // En modo equipos muestra 2 entradas (Equipo A y B); en individual, una por jugador.
  function renderScoreboard(container, players, scoreboard, mark, target, teams) {
    container.innerHTML = '';
    if (teams) {
      const winnerTeam = (mark !== null && mark !== undefined && mark >= 0) ? (mark % 2) : -1;
      for (let teamIdx = 0; teamIdx < 2; teamIdx++) {
        const score = scoreboard[teamIdx] || 0;
        const members = players.filter((_, i) => i % 2 === teamIdx);
        const li = document.createElement('li');
        const youInTeam = members.includes(myName);
        const nameSpan = document.createElement('span');
        nameSpan.className = 'sb-name';
        nameSpan.textContent = `Equipo ${teamIdx === 0 ? 'A' : 'B'}` +
          (youInTeam ? ' (tu equipo)' : '') +
          ' — ' + members.join(', ');
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

        li.classList.add(teamIdx === 0 ? 'team-a' : 'team-b');
        if (teamIdx === winnerTeam) li.classList.add('winner-mark');
        if (youInTeam) li.classList.add('you');
        container.appendChild(li);
      }
      return;
    }
    // Modo individual.
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
        btn.blur();
        // Si la mesa está vacía (primera ficha de la partida), no tiene
        // sentido preguntar dónde: simplemente la abrimos.
        const chainEmpty = !lastChainData
          || !lastChainData.chain
          || lastChainData.chain.length === 0;
        if (chainEmpty) {
          socket.emit('play_tile', { tile: t, end: 'right' });
          return;
        }
        if (entry.canPlay.left && entry.canPlay.right) {
          // Modo "elegir extremo": resaltamos las puntas de la cadena en la
          // mesa y el usuario hace click en la que prefiera.
          pendingTile = t;
          choosingEnd = true;
          renderChain(lastChainData.chain, lastChainData.ends, lastChainData.lastMove);
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

  // Recordar último nombre usado (localStorage).
  try {
    const savedName = localStorage.getItem('domino_lastname');
    if (savedName && !nameInput.value) nameInput.value = savedName;
  } catch (e) { /* ignore */ }

  // Auto-focus al campo apropiado.
  setTimeout(() => {
    if (!nameInput.value) nameInput.focus();
    else if (pathMatch) codeInput.focus();
    else nameInput.focus();
  }, 50);

  // Enter en cualquier input dispara la acción correspondiente.
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (codeInput.value.trim()) btnJoin.click();
      else btnCreate.click();
    }
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnJoin.click();
  });

  // ===== Acciones del lobby =====
  btnCreate.addEventListener('click', () => {
    clearError();
    const name = nameInput.value.trim();
    if (!name) { showError('Ingresa tu nombre'); return; }
    myName = name;
    rememberName(name);
    const modeRaw = modeSelect ? modeSelect.value : '4p';
    const mode = (modeRaw === '2p' || modeRaw === '2v2') ? modeRaw : '4p';
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
    rememberName(name);
    btnCreate.disabled = true;
    btnJoin.disabled = true;
    socket.emit('join_room', { name, code });
  });

  // ===== Helpers de copiar / salir =====
  function rememberName(name) {
    try { localStorage.setItem('domino_lastname', name); } catch (e) {}
  }

  function copyText(text, btn) {
    const fallback = () => {
      // Fallback para navegadores viejos / contextos no seguros (no HTTPS)
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(fallback);
    } else {
      fallback();
    }
    if (btn) {
      const original = btn.textContent;
      btn.textContent = 'copiado!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('copied');
      }, 1500);
    }
  }

  function leaveRoom() {
    if (!confirm('¿Salir de la sala? Si la partida está en curso, los demás serán notificados.')) return;
    // Limpiar localStorage de sala y volver al lobby con reload limpio.
    window.location.href = '/';
  }

  // Sala de espera
  if (btnCopyCode) {
    btnCopyCode.addEventListener('click', () => {
      copyText(myCode || roomCodeEl.textContent, btnCopyCode);
    });
  }
  if (btnCopyLink) {
    btnCopyLink.addEventListener('click', () => {
      const url = window.location.origin + '/room/' + (myCode || roomCodeEl.textContent);
      copyText(url, btnCopyLink);
    });
  }
  if (btnLeaveWaiting) {
    btnLeaveWaiting.addEventListener('click', leaveRoom);
  }

  // Vista de juego
  if (btnCopyCodeGame) {
    btnCopyCodeGame.addEventListener('click', () => {
      copyText(myCode || gameCodeEl.textContent, btnCopyCodeGame);
    });
  }
  if (btnLeaveGame) {
    btnLeaveGame.addEventListener('click', leaveRoom);
  }

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

  // Click en cualquier parte de la mesa que no sea un end-target → cancelar.
  chainEl.addEventListener('click', (e) => {
    if (choosingEnd && !e.target.closest('.end-target')) {
      cancelChooseEnd();
    }
  });

  // ESC cancela también.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && choosingEnd) {
      cancelChooseEnd();
    }
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
  socket.on('room_joined', ({ code, yourName, maxPlayers: mp, teams }) => {
    myCode = code;
    myName = yourName;
    hasJoined = true;
    if (mp) maxPlayers = mp;
    if (teams !== undefined) teamsMode = !!teams;
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
    if (state.teams !== undefined) teamsMode = !!state.teams;
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
    if (!yt) {
      closeEndSelector();
      if (choosingEnd) cancelChooseEnd();
    }
    renderHand();
    if (yt) {
      turnIndicator.textContent = 'TU TURNO';
      turnIndicator.classList.add('your-turn');
    }
  });

  socket.on('invalid_move', ({ reason }) => {
    showBanner('Jugada inválida: ' + reason, 'err');
    closeEndSelector();
    // Si el servidor dice que no estás en partida activa pero el cliente
    // cree que sí (típico post-reconexión donde no se re-linkeó el socket),
    // re-intentamos el join_room para volver a quedar enlazados.
    if (reason && reason.includes('No estás en una partida activa') &&
        hasJoined && myName && myCode) {
      socket.emit('join_room', { name: myName, code: myCode });
    }
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
    // En 2v2 el ganador es el equipo, pero también queremos saber si TU
    // equipo ganó.
    let won = (data.winnerName === myName);
    if (data.teams && data.winnerTeam !== null) {
      const myIdx = data.players.indexOf(myName);
      if (myIdx !== -1 && myIdx % 2 === data.winnerTeam) won = true;
    }
    rsTitle.textContent = won
      ? `¡Ganaste la mano ${data.roundNumber}!`
      : `Mano ${data.roundNumber}: ganó ${data.winnerName}`;
    rsReason.textContent = data.reason === 'domino'
      ? `${data.winnerPlayerName || data.winnerName} se quedó sin fichas (dominó)`
      : 'Trancado — menor cantidad de puntos en mano';
    rsPoints.textContent = `+${data.pointsAwarded} puntos a ${data.winnerName}`;
    renderScoreboard(rsScoreboard, data.players, data.scoreboard, data.winner, data.targetScore, data.teams);
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
    let won = (data.winnerName === myName);
    if (data.teams && data.winnerTeam !== null) {
      const myIdx = data.players.indexOf(myName);
      if (myIdx !== -1 && myIdx % 2 === data.winnerTeam) won = true;
    }
    overTitle.textContent = won
      ? '¡Ganaste la partida!'
      : `Ganó la partida: ${data.winnerName}`;
    // Para "alcanzó X puntos" usamos el score correcto (equipo o jugador).
    const winnerScore = data.teams
      ? data.scoreboard[data.winnerTeam]
      : data.scoreboard[data.winner];
    overReason.textContent = `${data.winnerName} alcanzó ${winnerScore} puntos en ${data.roundNumber} manos`;
    renderScoreboard(overScores, data.players, data.scoreboard, data.winner, data.targetScore, data.teams);
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

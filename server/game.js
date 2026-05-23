// Lógica pura del dominó: barajar, repartir, validar jugadas, calcular puntos.
// No conoce de Socket.IO ni de salas — recibe estado y devuelve estado nuevo.

// Construye el set estándar de 28 fichas, desde [0,0] hasta [6,6].
// Cada ficha es un array [a, b] con a <= b.
function createDeck() {
  const deck = [];
  for (let a = 0; a <= 6; a++) {
    for (let b = a; b <= 6; b++) {
      deck.push([a, b]);
    }
  }
  return deck;
}

// Barajar Fisher-Yates en sitio.
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Reparte 7 fichas a cada uno de los 4 jugadores.
function deal() {
  const deck = shuffle(createDeck());
  const hands = [[], [], [], []];
  for (let i = 0; i < 28; i++) {
    hands[i % 4].push(deck[i]);
  }
  return hands;
}

// Encuentra el índice del jugador que tiene el doble 6.
// Si nadie lo tiene, el doble más alto. Si no hay dobles (extremadamente raro
// con 4 manos de 7 — imposible en realidad), el jugador con la ficha más alta.
function findStarter(hands) {
  for (let dbl = 6; dbl >= 0; dbl--) {
    for (let p = 0; p < hands.length; p++) {
      if (hands[p].some(t => t[0] === dbl && t[1] === dbl)) {
        return { player: p, tile: [dbl, dbl] };
      }
    }
  }
  // Fallback: jugador con ficha de mayor suma.
  let best = { player: 0, tile: hands[0][0], sum: hands[0][0][0] + hands[0][0][1] };
  for (let p = 0; p < hands.length; p++) {
    for (const t of hands[p]) {
      const s = t[0] + t[1];
      if (s > best.sum) best = { player: p, tile: t, sum: s };
    }
  }
  return { player: best.player, tile: best.tile };
}

// Devuelve los extremos abiertos de la cadena (null si vacía).
function getEnds(chain) {
  if (chain.length === 0) return { left: null, right: null };
  return { left: chain[0][0], right: chain[chain.length - 1][1] };
}

// ¿La ficha encaja en algún extremo? Devuelve {left, right} booleanos.
function canPlay(tile, ends) {
  if (ends.left === null) return { left: true, right: true };
  const [a, b] = tile;
  return {
    left: a === ends.left || b === ends.left,
    right: a === ends.right || b === ends.right,
  };
}

// ¿Tiene el jugador alguna ficha jugable?
function hasAnyPlay(hand, ends) {
  if (ends.left === null) return hand.length > 0;
  return hand.some(t => {
    const c = canPlay(t, ends);
    return c.left || c.right;
  });
}

// Coloca la ficha en el extremo indicado, orientándola para que case.
// Devuelve la ficha tal como quedó en la cadena, o null si la jugada es inválida.
function placeTile(chain, tile, end) {
  const [a, b] = tile;
  if (chain.length === 0) {
    chain.push([a, b]);
    return [a, b];
  }
  if (end === 'left') {
    const leftVal = chain[0][0];
    let oriented;
    if (b === leftVal) oriented = [a, b];          // [a|b]-[b|...]
    else if (a === leftVal) oriented = [b, a];     // volteamos para que case
    else return null;
    chain.unshift(oriented);
    return oriented;
  } else if (end === 'right') {
    const rightVal = chain[chain.length - 1][1];
    let oriented;
    if (a === rightVal) oriented = [a, b];         // [...|right]-[a|b]
    else if (b === rightVal) oriented = [b, a];    // volteamos
    else return null;
    chain.push(oriented);
    return oriented;
  }
  return null;
}

// ¿La mano está trancada? Nadie puede jugar y nadie ganó.
function isBlocked(hands, ends) {
  return hands.every(h => !hasAnyPlay(h, ends));
}

// Suma de pips de una mano.
function handPoints(hand) {
  return hand.reduce((s, t) => s + t[0] + t[1], 0);
}

// Resuelve fin de mano. Devuelve { winner, reason, scores }.
// reason: 'domino' (alguien se quedó sin fichas) | 'trancado'.
function resolveEnd(hands, names) {
  const scores = hands.map((h, i) => ({
    player: i,
    name: names[i],
    points: handPoints(h),
    tilesLeft: h.length,
  }));

  // ¿Alguien se quedó sin fichas?
  const dominoed = hands.findIndex(h => h.length === 0);
  if (dominoed !== -1) {
    return { winner: dominoed, reason: 'domino', scores };
  }
  // Trancado: gana quien tenga menos puntos.
  let minPts = Infinity;
  let winner = 0;
  for (let i = 0; i < hands.length; i++) {
    if (scores[i].points < minPts) {
      minPts = scores[i].points;
      winner = i;
    }
  }
  return { winner, reason: 'trancado', scores };
}

// Quita una ficha específica de la mano (compara ambos valores en cualquier orden).
function removeTile(hand, tile) {
  const [a, b] = tile;
  const idx = hand.findIndex(t =>
    (t[0] === a && t[1] === b) || (t[0] === b && t[1] === a)
  );
  if (idx === -1) return false;
  hand.splice(idx, 1);
  return true;
}

module.exports = {
  createDeck,
  shuffle,
  deal,
  findStarter,
  getEnds,
  canPlay,
  hasAnyPlay,
  placeTile,
  isBlocked,
  handPoints,
  resolveEnd,
  removeTile,
};

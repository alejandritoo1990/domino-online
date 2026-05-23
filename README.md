# Dominó multijugador

Juego de dominó en tiempo real para 4 jugadores. Backend en Node.js + Socket.IO,
frontend en HTML/CSS/JS vanilla. Sin base de datos: todo el estado vive en memoria
del servidor.

## Estructura

```
/server
  index.js   Express + Socket.IO, sirve /public
  game.js    Lógica del dominó (barajar, validar, calcular puntos)
  rooms.js   Salas en memoria, generador de códigos
/public
  index.html landing (crear/unirse)
  game.html  sala de espera + juego + fin
  style.css  estilos mínimos en monoespaciada
  client.js  cliente único (lobby y juego)
package.json
```

## Correr en local

Requisitos: Node.js 18 o superior.

```bash
npm install
npm start
```

Abre `http://localhost:3000` en 4 pestañas distintas para probar una partida
completa con vos solito. Una crea la sala, las otras tres se unen con el código
mostrado. Al llegar a 4 jugadores, la partida arranca sola.

Para desarrollo con auto-reload:

```bash
npm run dev
```

## Cómo se juega

1. **Inicio**: ingresa tu nombre y crea una sala (o únete con código).
2. **Sala de espera**: comparte el código de 5 letras. La partida empieza
   automáticamente al llegar 4 jugadores.
3. **Reparto**: 7 fichas por jugador. Empieza quien tenga el doble 6
   (o el doble más alto disponible).
4. **Turnos**: en tu turno, los botones de las fichas que sí encajan en algún
   extremo se ven activos. Click para jugar. Si la ficha encaja en los dos
   extremos, aparece un selector "Izquierda / Derecha".
5. **Pasar**: el botón "Pasar" sólo se habilita si no tienes jugadas válidas.
6. **Fin**:
   - **Dominó**: alguien se queda sin fichas, gana.
   - **Trancado**: nadie puede jugar; gana quien tenga menos puntos en mano.

Si un jugador se desconecta durante la partida, los demás reciben un aviso y
hay 60 segundos de gracia para que vuelva (entrando con el mismo nombre al
mismo código). Si no vuelve, la mano se cancela.

## Deploy en Render

Render Web Service gratuito sirve perfecto para probar (el servicio duerme tras
inactividad — al volver a abrir tarda unos segundos en arrancar).

### Pasos

1. **Sube el repo a GitHub**:

   ```bash
   git init
   git add .
   git commit -m "Dominó multijugador inicial"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
   git push -u origin main
   ```

2. **Crea el servicio en Render**:
   - Entra a [render.com](https://render.com), inicia sesión y haz click en
     **New > Web Service**.
   - Conecta tu cuenta de GitHub y selecciona el repo.

3. **Configura el servicio**:
   - **Environment**: `Node`
   - **Region**: la que prefieras (ej. Oregon)
   - **Branch**: `main`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: **Free**

4. **Deploy**: Render detecta los pushes a `main` y redeploya solo.

5. **Abrir**: cuando termine, Render te da una URL tipo
   `https://tu-app.onrender.com`. Compártela y ya pueden jugar 4 personas desde
   distintos navegadores.

### Notas para Render

- El servidor escucha en `process.env.PORT || 3000`, así que Render lo detecta.
- Socket.IO está configurado con CORS abierto (`origin: '*'`). En producción,
  si querés restringirlo al mismo dominio, edita `server/index.js`:
  ```js
  cors: { origin: 'https://tu-app.onrender.com' }
  ```
- Como el estado vive en memoria, si Render reinicia el servicio se pierden las
  salas activas. Para una partida casual está bien; si quieres persistencia
  habría que sumar Redis o una DB.
- El plan gratuito duerme tras 15 min sin tráfico. La primera petición tras
  dormir tarda ~30 segundos.

## Eventos Socket.IO

**Cliente → Servidor:**
- `create_room { name }`
- `join_room { code, name }`
- `play_tile { tile: [a,b], end: 'left' | 'right' }`
- `pass_turn`

**Servidor → Cliente:**
- `room_joined { code, yourName }`
- `room_update { code, status, players }`
- `game_started { ... estado público ... }`
- `game_state { chain, ends, turn, turnName, players, log }`
- `hand_update { hand, yourTurn, canPass }` — privado a cada socket
- `invalid_move { reason }`
- `game_over { winner, winnerName, reason, scores }`
- `player_disconnected { name, graceSeconds }`
- `player_reconnected { name }`
- `error_msg { message }`

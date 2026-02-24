// =============================================
// PYTHON HUNTER v4 — SERVER.JS
// Node.js + Socket.IO Multiplayer Backend
// =============================================

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 20000,
  pingInterval: 10000
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../client')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

// =============================================
// IN-MEMORY STORAGE
// =============================================
const rooms = new Map();      // roomCode → Room object
const players = new Map();    // socketId → Player object

// =============================================
// ROOM STRUCTURE
// {
//   code, hostId, mode, timeLimit, winScore,
//   status: 'waiting' | 'playing' | 'ended',
//   players: Map(socketId → {name, score, hp, ready, done}),
//   questionIndex, questions, startTime, timer, timerInterval
// }
// =============================================

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Shared question database
const QUESTIONS = require('./data/questions');

function getQuestions(mode) {
  let pool = mode === 'SURVIVAL'
    ? QUESTIONS.filter(q => q.level >= 6)
    : QUESTIONS.filter(q => q.mode === mode);
  if (!pool.length) pool = QUESTIONS;
  return shuffleArray(pool);
}

// =============================================
// SOCKET.IO EVENTS
// =============================================
io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  // ── CREATE ROOM ──────────────────────────
  socket.on('create_room', ({ playerName, mode, timeLimit }) => {
    const code = generateRoomCode();
    const winScoreMap = { 60: 800, 120: 1500, 180: 2000 };
    const itemsMap    = { 60: 1,   120: 2,    180: 3 };
    const tl = parseInt(timeLimit) || 60;

    const room = {
      code,
      hostId: socket.id,
      mode: mode || 'BASICS',
      timeLimit: tl,
      winScore: winScoreMap[tl] || 800,
      defaultItems: itemsMap[tl] || 1,
      status: 'waiting',
      players: new Map(),
      questions: [],
      questionIndex: 0,
      startTime: null,
      timerInterval: null,
      globalTimer: tl,
    };

    const player = {
      socketId: socket.id,
      name: (playerName || 'PLAYER').toUpperCase().slice(0, 12),
      score: 0,
      hp: 100,
      combo: 0,
      hints: room.defaultItems,
      potions: room.defaultItems,
      skips: room.defaultItems,
      ready: false,
      done: false,
      rank: null,
    };

    room.players.set(socket.id, player);
    rooms.set(code, room);
    players.set(socket.id, { roomCode: code, name: player.name });

    socket.join(code);
    socket.emit('room_created', {
      roomCode: code,
      mode: room.mode,
      timeLimit: room.timeLimit,
      winScore: room.winScore,
      isHost: true,
    });
    socket.emit('room_update', serializeRoom(room));
    console.log(`[ROOM] ${code} created by ${player.name} | mode:${mode}`);
  });

  // ── JOIN ROOM ────────────────────────────
  socket.on('join_room', ({ playerName, roomCode }) => {
    const code = roomCode?.toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('error_msg', 'ไม่พบห้อง — ตรวจสอบรหัสอีกครั้ง');
      return;
    }
    if (room.status !== 'waiting') {
      socket.emit('error_msg', 'เกมเริ่มแล้ว ไม่สามารถเข้าร่วมได้');
      return;
    }
    if (room.players.size >= 8) {
      socket.emit('error_msg', 'ห้องเต็มแล้ว (สูงสุด 8 คน)');
      return;
    }

    const player = {
      socketId: socket.id,
      name: (playerName || 'PLAYER').toUpperCase().slice(0, 12),
      score: 0,
      hp: 100,
      combo: 0,
      hints: room.defaultItems,
      potions: room.defaultItems,
      skips: room.defaultItems,
      ready: false,
      done: false,
      rank: null,
    };

    room.players.set(socket.id, player);
    players.set(socket.id, { roomCode: code, name: player.name });

    socket.join(code);
    socket.emit('room_joined', {
      roomCode: code,
      mode: room.mode,
      timeLimit: room.timeLimit,
      winScore: room.winScore,
      isHost: false,
    });
    io.to(code).emit('room_update', serializeRoom(room));
    io.to(code).emit('chat_msg', { system: true, text: `${player.name} เข้าร่วมห้อง!` });
    console.log(`[JOIN] ${player.name} → room ${code}`);
  });

  // ── PLAYER READY ─────────────────────────
  socket.on('player_ready', () => {
    const info = players.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomCode);
    if (!room || room.status !== 'waiting') return;
    const player = room.players.get(socket.id);
    if (!player) return;

    player.ready = !player.ready;
    io.to(info.roomCode).emit('room_update', serializeRoom(room));
  });

  // ── START GAME (host only) ────────────────
  socket.on('start_game', () => {
    const info = players.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomCode);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.size < 1) return;
    if (room.status !== 'waiting') return;

    // Init game state
    room.status = 'playing';
    room.questions = getQuestions(room.mode);
    room.questionIndex = 0;
    room.globalTimer = room.timeLimit;
    room.startTime = Date.now();

    // Reset all players
    room.players.forEach(p => {
      p.score = 0; p.hp = 100; p.combo = 0; p.done = false; p.rank = null;
      p.hints = room.defaultItems; p.potions = room.defaultItems; p.skips = room.defaultItems;
    });

    io.to(info.roomCode).emit('game_started', {
      mode: room.mode,
      timeLimit: room.timeLimit,
      winScore: room.winScore,
      question: serializeQuestion(room.questions[0]),
      defaultItems: room.defaultItems,
    });

    // Start server-side countdown
    startRoomTimer(room, info.roomCode);
    console.log(`[START] Room ${info.roomCode} | ${room.players.size} players`);
  });

  // ── SUBMIT ANSWER ─────────────────────────
  socket.on('submit_answer', ({ answer }) => {
    const info = players.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomCode);
    if (!room || room.status !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player || player.done) return;

    // Each player has their own question index (stored per player)
    const qIdx = player.questionIndex !== undefined ? player.questionIndex : 0;
    const question = room.questions[qIdx % room.questions.length];
    if (!question) return;

    const correct = question.ans.toLowerCase().trim();
    const given = (answer || '').toLowerCase().trim();
    const isCorrect = given === correct;

    if (isCorrect) {
      player.combo = (player.combo || 0) + 1;
      const comboBonus = player.combo >= 5 ? 75 : player.combo >= 3 ? 50 : 0;
      const earned = 150 + comboBonus;
      player.score += earned;

      // Time bonus every 3 combos
      let timeBonusGiven = false;
      if (player.combo % 3 === 0) timeBonusGiven = true;

      player.questionIndex = (qIdx + 1) % room.questions.length;
      const nextQ = room.questions[player.questionIndex];

      socket.emit('answer_result', {
        correct: true,
        earned,
        combo: player.combo,
        score: player.score,
        timeBonusGiven,
        nextQuestion: serializeQuestion(nextQ),
      });

      // Check win
      if (player.score >= room.winScore) {
        player.done = true;
        player.rank = countDone(room);
        socket.emit('player_won', { score: player.score, rank: player.rank });
      }
    } else {
      player.combo = 0;
      player.hp = Math.max(0, player.hp - 20);

      socket.emit('answer_result', {
        correct: false,
        hp: player.hp,
        combo: 0,
        score: player.score,
      });

      if (player.hp <= 0) {
        player.done = true;
        player.rank = countDone(room);
        socket.emit('player_eliminated', { score: player.score });
      }
    }

    // Broadcast live scoreboard to room
    io.to(info.roomCode).emit('score_update', getScoreboard(room));

    // Check if all done
    checkAllDone(room, info.roomCode);
  });

  // ── USE ITEM ──────────────────────────────
  socket.on('use_item', ({ item }) => {
    const info = players.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomCode);
    if (!room || room.status !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player || player.done) return;

    const qIdx = player.questionIndex !== undefined ? player.questionIndex : 0;
    const question = room.questions[qIdx % room.questions.length];

    if (item === 'hint' && player.hints > 0) {
      player.hints--;
      player.score = Math.max(0, player.score - 50);
      const hint = question.ans.substring(0, Math.max(1, Math.ceil(question.ans.length * 0.4)));
      socket.emit('item_used', { item: 'hint', hint, score: player.score, hints: player.hints });
    } else if (item === 'potion' && player.potions > 0 && player.hp < 100) {
      player.potions--;
      player.hp = Math.min(100, player.hp + 30);
      socket.emit('item_used', { item: 'potion', hp: player.hp, potions: player.potions });
    } else if (item === 'skip' && player.skips > 0) {
      player.skips--;
      player.score = Math.max(0, player.score - 100);
      player.combo = 0;
      player.questionIndex = (qIdx + 1) % room.questions.length;
      const nextQ = room.questions[player.questionIndex];
      socket.emit('item_used', { item: 'skip', score: player.score, skips: player.skips, nextQuestion: serializeQuestion(nextQ) });
    }

    io.to(info.roomCode).emit('score_update', getScoreboard(room));
  });

  // ── DISCONNECT ────────────────────────────
  socket.on('disconnect', () => {
    const info = players.get(socket.id);
    if (!info) return;
    const room = rooms.get(info.roomCode);
    players.delete(socket.id);
    if (!room) return;

    room.players.delete(socket.id);
    io.to(info.roomCode).emit('chat_msg', { system: true, text: `${info.name} ออกจากห้อง` });

    if (room.players.size === 0) {
      clearRoomTimer(room);
      rooms.delete(info.roomCode);
      console.log(`[ROOM] ${info.roomCode} deleted (empty)`);
      return;
    }

    // Transfer host if needed
    if (room.hostId === socket.id) {
      const newHostId = room.players.keys().next().value;
      room.hostId = newHostId;
      io.to(newHostId).emit('you_are_host');
    }

    io.to(info.roomCode).emit('room_update', serializeRoom(room));
    checkAllDone(room, info.roomCode);
  });

  // ── CHAT ──────────────────────────────────
  socket.on('send_chat', ({ text }) => {
    const info = players.get(socket.id);
    if (!info || !text) return;
    const msg = text.trim().slice(0, 80);
    if (!msg) return;
    io.to(info.roomCode).emit('chat_msg', { name: info.name, text: msg });
  });
});

// =============================================
// HELPERS
// =============================================
function startRoomTimer(room, roomCode) {
  clearRoomTimer(room);
  room.timerInterval = setInterval(() => {
    room.globalTimer--;
    io.to(roomCode).emit('timer_tick', { time: room.globalTimer });
    if (room.globalTimer <= 0) {
      clearRoomTimer(room);
      endGame(room, roomCode, 'timeout');
    }
  }, 1000);
}

function clearRoomTimer(room) {
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
}

function countDone(room) {
  let c = 0;
  room.players.forEach(p => { if (p.done) c++; });
  return c;
}

function checkAllDone(room, roomCode) {
  let allDone = true;
  room.players.forEach(p => { if (!p.done) allDone = false; });
  if (allDone && room.status === 'playing') {
    clearRoomTimer(room);
    endGame(room, roomCode, 'all_done');
  }
}

function endGame(room, roomCode, reason) {
  if (room.status === 'ended') return;
  room.status = 'ended';

  const scoreboard = getScoreboard(room);
  // Assign ranks to remaining players
  scoreboard.forEach((p, i) => {
    const rp = room.players.get(p.socketId);
    if (rp && !rp.done) rp.rank = i + 1;
  });

  io.to(roomCode).emit('game_ended', { scoreboard, reason });
  console.log(`[END] Room ${roomCode} | reason:${reason}`);

  // Auto-clean room after 5 min
  setTimeout(() => {
    clearRoomTimer(room);
    rooms.delete(roomCode);
  }, 5 * 60 * 1000);
}

function getScoreboard(room) {
  const arr = [];
  room.players.forEach(p => {
    arr.push({ socketId: p.socketId, name: p.name, score: p.score, hp: p.hp, done: p.done, rank: p.rank, combo: p.combo || 0 });
  });
  return arr.sort((a, b) => b.score - a.score);
}

function serializeRoom(room) {
  const playerList = [];
  room.players.forEach(p => {
    playerList.push({ socketId: p.socketId, name: p.name, score: p.score, hp: p.hp, ready: p.ready, done: p.done, combo: p.combo || 0 });
  });
  return {
    code: room.code,
    hostId: room.hostId,
    mode: room.mode,
    timeLimit: room.timeLimit,
    winScore: room.winScore,
    status: room.status,
    players: playerList.sort((a, b) => b.score - a.score),
  };
}

function serializeQuestion(q) {
  if (!q) return null;
  return { id: q.id, text: q.text, code: q.code, mode: q.mode, level: q.level };
}

// =============================================
// START SERVER
// =============================================
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n🐍 PYTHON HUNTER v4 SERVER`);
  console.log(`   Running on port ${PORT}`);
  console.log(`   Rooms: ${rooms.size} | Players: ${players.size}\n`);
});
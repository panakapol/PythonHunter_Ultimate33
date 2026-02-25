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

app.use(express.static(path.join(__dirname, '../client')));
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, '../client/index.html')); });

const rooms = new Map();
const players = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); } while (rooms.has(code));
  return code;
}

// อัลกอริทึมจัดเรียงคำถาม: เรียงตาม Level (ง่ายไปยาก) และสุ่มสลับภายใน Level เดียวกัน
function sortAndShuffleByLevel(pool) {
  const grouped = {};
  pool.forEach(q => {
    if(!grouped[q.level]) grouped[q.level] = [];
    grouped[q.level].push(q);
  });
  let finalPool = [];
  Object.keys(grouped).sort((a,b) => a - b).forEach(lvl => {
    let arr = grouped[lvl];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    finalPool = finalPool.concat(arr);
  });
  return finalPool;
}

const QUESTIONS = require('./data/questions');

function getQuestions(mode) {
  let pool = mode === 'SURVIVAL' ? QUESTIONS.filter(q => q.level >= 6) : QUESTIONS.filter(q => q.mode === mode);
  if (!pool.length) pool = QUESTIONS;
  return sortAndShuffleByLevel(pool);
}

io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  socket.on('create_room', ({ playerName, mode, timeLimit }) => {
    const code = generateRoomCode();
    const tl = parseInt(timeLimit) || 60;
    const itemsMap = { 60: 1, 120: 2, 180: 3 };

    const room = {
      code, hostId: socket.id, mode: mode || 'BASICS', timeLimit: tl,
      defaultItems: itemsMap[tl] || 1, status: 'waiting', players: new Map(),
      questions: [], questionIndex: 0, startTime: null, timerInterval: null, globalTimer: tl,
    };

    const player = {
      socketId: socket.id, name: (playerName || 'PLAYER').toUpperCase().slice(0, 12),
      score: 0, hp: 100, combo: 0,
      hints: room.defaultItems, potions: room.defaultItems, skips: room.defaultItems,
      ready: false, done: false, rank: null,
    };

    room.players.set(socket.id, player); rooms.set(code, room); players.set(socket.id, { roomCode: code, name: player.name });
    socket.join(code);
    socket.emit('room_created', { roomCode: code, mode: room.mode, timeLimit: room.timeLimit, isHost: true });
    socket.emit('room_update', serializeRoom(room));
  });

  socket.on('join_room', ({ playerName, roomCode }) => {
    const code = roomCode?.toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return socket.emit('error_msg', 'ไม่พบห้อง — ตรวจสอบรหัสอีกครั้ง');
    if (room.status !== 'waiting') return socket.emit('error_msg', 'เกมเริ่มแล้ว ไม่สามารถเข้าร่วมได้');
    if (room.players.size >= 8) return socket.emit('error_msg', 'ห้องเต็มแล้ว (สูงสุด 8 คน)');

    const player = {
      socketId: socket.id, name: (playerName || 'PLAYER').toUpperCase().slice(0, 12),
      score: 0, hp: 100, combo: 0,
      hints: room.defaultItems, potions: room.defaultItems, skips: room.defaultItems,
      ready: false, done: false, rank: null,
    };

    room.players.set(socket.id, player); players.set(socket.id, { roomCode: code, name: player.name });
    socket.join(code);
    socket.emit('room_joined', { roomCode: code, mode: room.mode, timeLimit: room.timeLimit, isHost: false });
    io.to(code).emit('room_update', serializeRoom(room));
    io.to(code).emit('chat_msg', { system: true, text: `${player.name} เข้าร่วมห้อง!` });
  });

  socket.on('player_ready', () => {
    const info = players.get(socket.id); if (!info) return;
    const room = rooms.get(info.roomCode); if (!room || room.status !== 'waiting') return;
    const player = room.players.get(socket.id); if (!player) return;
    player.ready = !player.ready;
    io.to(info.roomCode).emit('room_update', serializeRoom(room));
  });

  socket.on('start_game', () => {
    const info = players.get(socket.id); if (!info) return;
    const room = rooms.get(info.roomCode); if (!room || room.hostId !== socket.id) return;
    if (room.players.size < 1 || room.status !== 'waiting') return;

    room.status = 'playing'; room.questions = getQuestions(room.mode);
    room.questionIndex = 0; room.globalTimer = room.timeLimit; room.startTime = Date.now();

    room.players.forEach(p => {
      p.score = 0; p.hp = 100; p.combo = 0; p.done = false; p.rank = null; p.questionIndex = 0;
      p.hints = room.defaultItems; p.potions = room.defaultItems; p.skips = room.defaultItems;
    });

    io.to(info.roomCode).emit('game_started', {
      mode: room.mode, timeLimit: room.timeLimit,
      question: serializeQuestion(room.questions[0]), defaultItems: room.defaultItems,
    });
    startRoomTimer(room, info.roomCode);
  });

  socket.on('submit_answer', ({ answer }) => {
    const info = players.get(socket.id); if (!info) return;
    const room = rooms.get(info.roomCode); if (!room || room.status !== 'playing') return;
    const player = room.players.get(socket.id); if (!player || player.done) return;

    const qIdx = player.questionIndex !== undefined ? player.questionIndex : 0;
    const question = room.questions[qIdx % room.questions.length]; if (!question) return;

    const correct = question.ans.toLowerCase().trim();
    const given = (answer || '').toLowerCase().trim();

    if (given === correct) {
      player.combo = (player.combo || 0) + 1;
      const earned = 150 + (player.combo >= 5 ? 75 : player.combo >= 3 ? 50 : 0);
      player.score += earned;
      let timeBonusGiven = player.combo % 3 === 0;

      player.questionIndex = (qIdx + 1) % room.questions.length;
      socket.emit('answer_result', { correct: true, earned, combo: player.combo, score: player.score, timeBonusGiven, nextQuestion: serializeQuestion(room.questions[player.questionIndex]) });
      
    } else {
      player.combo = 0; player.hp = Math.max(0, player.hp - 20);
      socket.emit('answer_result', { correct: false, hp: player.hp, combo: 0, score: player.score });
      if (player.hp <= 0) {
        player.done = true; player.rank = countDone(room);
        socket.emit('player_eliminated', { score: player.score });
      }
    }
    io.to(info.roomCode).emit('score_update', getScoreboard(room));
    checkAllDone(room, info.roomCode);
  });

  socket.on('use_item', ({ item }) => {
    const info = players.get(socket.id); if (!info) return;
    const room = rooms.get(info.roomCode); if (!room || room.status !== 'playing') return;
    const player = room.players.get(socket.id); if (!player || player.done) return;
    const qIdx = player.questionIndex !== undefined ? player.questionIndex : 0;
    const question = room.questions[qIdx % room.questions.length];

    if (item === 'hint' && player.hints > 0) {
      player.hints--; player.score = Math.max(0, player.score - 50);
      socket.emit('item_used', { item: 'hint', hint: question.ans.substring(0, Math.max(1, Math.ceil(question.ans.length * 0.4))), score: player.score, hints: player.hints });
    } else if (item === 'potion' && player.potions > 0 && player.hp < 100) {
      player.potions--; player.hp = Math.min(100, player.hp + 30);
      socket.emit('item_used', { item: 'potion', hp: player.hp, potions: player.potions });
    } else if (item === 'skip' && player.skips > 0) {
      player.skips--; player.score = Math.max(0, player.score - 100); player.combo = 0;
      player.questionIndex = (qIdx + 1) % room.questions.length;
      socket.emit('item_used', { item: 'skip', score: player.score, skips: player.skips, nextQuestion: serializeQuestion(room.questions[player.questionIndex]) });
    }
    io.to(info.roomCode).emit('score_update', getScoreboard(room));
  });

  socket.on('disconnect', () => {
    const info = players.get(socket.id); if (!info) return;
    const room = rooms.get(info.roomCode); players.delete(socket.id); if (!room) return;
    room.players.delete(socket.id);
    io.to(info.roomCode).emit('chat_msg', { system: true, text: `${info.name} ออกจากห้อง` });

    if (room.players.size === 0) { clearRoomTimer(room); rooms.delete(info.roomCode); return; }
    if (room.hostId === socket.id) { room.hostId = room.players.keys().next().value; io.to(room.hostId).emit('you_are_host'); }
    io.to(info.roomCode).emit('room_update', serializeRoom(room)); checkAllDone(room, info.roomCode);
  });

  socket.on('send_chat', ({ text }) => {
    const info = players.get(socket.id); if (!info || !text) return;
    const msg = text.trim().slice(0, 80); if (!msg) return;
    io.to(info.roomCode).emit('chat_msg', { name: info.name, text: msg });
  });
});

function startRoomTimer(room, roomCode) {
  clearRoomTimer(room);
  room.timerInterval = setInterval(() => {
    room.globalTimer--; io.to(roomCode).emit('timer_tick', { time: room.globalTimer });
    if (room.globalTimer <= 0) { clearRoomTimer(room); endGame(room, roomCode, 'timeout'); }
  }, 1000);
}

function clearRoomTimer(room) { if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; } }

function countDone(room) { let c = 0; room.players.forEach(p => { if (p.done) c++; }); return c; }

function checkAllDone(room, roomCode) {
  let allDone = true; room.players.forEach(p => { if (!p.done) allDone = false; });
  if (allDone && room.status === 'playing') { clearRoomTimer(room); endGame(room, roomCode, 'all_done'); }
}

function endGame(room, roomCode, reason) {
  if (room.status === 'ended') return; room.status = 'ended';
  const scoreboard = getScoreboard(room);
  scoreboard.forEach((p, i) => { const rp = room.players.get(p.socketId); if (rp && !rp.done) rp.rank = i + 1; });
  io.to(roomCode).emit('game_ended', { scoreboard, reason });
  
  // FIX: สั่งรีเซ็ตสถานะห้องกลับไปหน้า Lobby รอเล่นตาต่อไป (หลีกเลี่ยงบั๊กกด Play Again ค้าง)
  setTimeout(() => {
    if (rooms.has(roomCode)) {
      room.status = 'waiting';
      room.players.forEach(p => { p.ready = false; p.done = false; });
      io.to(roomCode).emit('room_update', serializeRoom(room));
    }
  }, 2000); 

  setTimeout(() => { 
    if(rooms.has(roomCode) && rooms.get(roomCode).status === 'waiting' && rooms.get(roomCode).players.size === 0) {
      clearRoomTimer(room); rooms.delete(roomCode); 
    }
  }, 15 * 60 * 1000); // เคลียร์ห้องทิ้งถ้าไม่มีคนอยู่เลยใน 15 นาที
}

function getScoreboard(room) {
  const arr = []; room.players.forEach(p => { arr.push({ socketId: p.socketId, name: p.name, score: p.score, hp: p.hp, done: p.done, rank: p.rank, combo: p.combo || 0 }); });
  return arr.sort((a, b) => b.score - a.score);
}

function serializeRoom(room) {
  const playerList = []; room.players.forEach(p => { playerList.push({ socketId: p.socketId, name: p.name, score: p.score, hp: p.hp, ready: p.ready, done: p.done, combo: p.combo || 0 }); });
  return { code: room.code, hostId: room.hostId, mode: room.mode, timeLimit: room.timeLimit, status: room.status, players: playerList.sort((a, b) => b.score - a.score) };
}

function serializeQuestion(q) { if (!q) return null; return { id: q.id, text: q.text, code: q.code, mode: q.mode, level: q.level }; }

const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => {
  console.log(`\n🐍 PYTHON HUNTER v4 SERVER`);
  console.log(`   Running on port ${PORT}`);
});
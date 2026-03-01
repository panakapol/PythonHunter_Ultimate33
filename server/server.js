// =============================================
// PYTHON HUNTER v4 — SERVER.JS
// Node.js + Socket.IO + MongoDB Auth + Ranked
// แก้ไข: ย้าย wildcard route ไปหลัง API routes
//        เพื่อให้ /api/... ทำงานได้ถูกต้อง
// =============================================
require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const axios = require('axios');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 20000,
  pingInterval: 10000
});

// =============================================
// MIDDLEWARE — อ่าน JSON body และเสิร์ฟไฟล์ static
// =============================================
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

// =============================================
// MONGODB CONNECTION — เชื่อมต่อฐานข้อมูล
// =============================================
const MONGO_URI = process.env.MONGO_URI || '';
let db = null;

async function connectDB() {
  if (!MONGO_URI) { console.log('[DB] No MONGO_URI — leaderboard/auth disabled'); return; }
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('pythonhunter');
    console.log('[DB] MongoDB connected');
    // สร้าง index ให้ค้นหาเร็วขึ้น
    await db.collection('users').createIndex({ username: 1 }, { unique: true });
    await db.collection('ranked_scores').createIndex({ weekKey: 1, score: -1 });
    scheduleWeeklyReset();
  } catch (e) {
    console.error('[DB] Connect failed:', e.message);
  }
}
connectDB();

// =============================================
// HELPER FUNCTIONS — ฟังก์ชันช่วยเหลือต่างๆ
// =============================================

// เข้ารหัส password ด้วย SHA256 + salt
function hashPassword(pass) {
  return crypto.createHash('sha256').update(pass + 'ph_salt_v4').digest('hex');
}

// สร้าง token สุ่มสำหรับ session
function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

// คำนวณ week key สำหรับ leaderboard รายสัปดาห์ (เริ่มวันจันทร์)
function getWeekKey() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now);
  monday.setDate(diff);
  monday.setHours(0, 0, 0, 0);
  return `${monday.getFullYear()}-${String(monday.getMonth()+1).padStart(2,'0')}-${String(monday.getDate()).padStart(2,'0')}`;
}

// คำนวณมิลลิวินาทีจนถึงวันจันทร์หน้า (เวลา reset leaderboard)
function getNextMondayMs() {
  const now = new Date();
  const day = now.getDay();
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  const next = new Date(now);
  next.setDate(now.getDate() + daysUntilMonday);
  next.setHours(0, 0, 0, 0);
  return next.getTime() - Date.now();
}

// ตั้งเวลา reset leaderboard ทุกสัปดาห์วันจันทร์ 00:00
function scheduleWeeklyReset() {
  const ms = getNextMondayMs();
  console.log(`[RESET] Next weekly reset in ${Math.round(ms/3600000)}h`);
  setTimeout(() => {
    console.log('[RESET] Weekly leaderboard reset!');
    scheduleWeeklyReset();
  }, ms);
}

// เก็บ token ไว้ใน memory (ถ้า server restart ต้อง login ใหม่)
const tokenStore = new Map();

// middleware ตรวจสอบ token ก่อนเข้า API ที่ต้อง auth
function authMiddleware(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ error: 'No token' });
  const session = tokenStore.get(token);
  if (!session) return res.status(401).json({ error: 'Invalid token' });
  req.user = session;
  next();
}

// =============================================
// AUTH API — ระบบสมาชิก Login / Register
// =============================================

// สมัครสมาชิกใหม่
app.post('/api/register', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'ระบบฐานข้อมูลไม่พร้อม' });
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'กรุณาใส่ username และ password' });
  if (username.length < 3 || username.length > 16) return res.status(400).json({ error: 'Username ต้องยาว 3-16 ตัวอักษร' });
  if (password.length < 4) return res.status(400).json({ error: 'Password ต้องยาวอย่างน้อย 4 ตัว' });
  const clean = username.toUpperCase().replace(/[^A-Z0-9_]/g, '');
  if (!clean) return res.status(400).json({ error: 'Username ใช้ได้เฉพาะ A-Z, 0-9, _' });
  try {
    await db.collection('users').insertOne({
      username: clean, password: hashPassword(password),
      createdAt: new Date(), totalGames: 0, bestScore: 0
    });
    const token = makeToken();
    tokenStore.set(token, { username: clean });
    res.json({ success: true, token, username: clean });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ error: 'Username นี้มีคนใช้แล้ว' });
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// เข้าสู่ระบบ
app.post('/api/login', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'ระบบฐานข้อมูลไม่พร้อม' });
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'กรุณาใส่ username และ password' });
  try {
    const user = await db.collection('users').findOne({ username: username.toUpperCase() });
    if (!user || user.password !== hashPassword(password))
      return res.status(401).json({ error: 'Username หรือ Password ไม่ถูกต้อง' });
    const token = makeToken();
    tokenStore.set(token, { username: user.username });
    res.json({ success: true, token, username: user.username });
  } catch (e) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// ออกจากระบบ ลบ token
app.post('/api/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) tokenStore.delete(token);
  res.json({ success: true });
});

// =============================================
// RANKED LEADERBOARD API — ระบบ Ranked Mode
// =============================================

// บันทึกคะแนน Ranked (เก็บเฉพาะคะแนนสูงสุดของสัปดาห์)
app.post('/api/ranked/submit', authMiddleware, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'ระบบฐานข้อมูลไม่พร้อม' });
  const { score, questionsAnswered } = req.body;
  if (typeof score !== 'number' || score < 0) return res.status(400).json({ error: 'Invalid score' });
  const weekKey = getWeekKey();
  const username = req.user.username;
  try {
    const existing = await db.collection('ranked_scores').findOne({ weekKey, username });
    const isNewBest = !existing || score > existing.score;
    if (isNewBest) {
      // อัปเดตเฉพาะถ้าคะแนนใหม่ดีกว่า
      await db.collection('ranked_scores').updateOne(
        { weekKey, username },
        { $set: { score, questionsAnswered: questionsAnswered || 0, updatedAt: new Date(), username, weekKey } },
        { upsert: true }
      );
      await db.collection('users').updateOne({ username }, { $max: { bestScore: score }, $inc: { totalGames: 1 } });
    } else {
      await db.collection('users').updateOne({ username }, { $inc: { totalGames: 1 } });
    }
    res.json({ success: true, isNewBest });
  } catch (e) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// ดึงข้อมูล leaderboard top 100 ของสัปดาห์นี้
app.get('/api/ranked/leaderboard', async (req, res) => {
  if (!db) return res.json({ leaderboard: [], weekKey: getWeekKey(), nextReset: getNextMondayMs() });
  const weekKey = getWeekKey();
  try {
    const top = await db.collection('ranked_scores')
      .find({ weekKey }).sort({ score: -1 }).limit(100).toArray();
    res.json({ leaderboard: top, weekKey, nextReset: getNextMondayMs() });
  } catch (e) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// ดูอันดับของตัวเองในสัปดาห์นี้
app.get('/api/ranked/myrank', authMiddleware, async (req, res) => {
  if (!db) return res.json({ rank: null, score: 0 });
  const weekKey = getWeekKey();
  const username = req.user.username;
  try {
    const myScore = await db.collection('ranked_scores').findOne({ weekKey, username });
    if (!myScore) return res.json({ rank: null, score: 0 });
    const rank = await db.collection('ranked_scores').countDocuments({ weekKey, score: { $gt: myScore.score } });
    res.json({ rank: rank + 1, score: myScore.score, questionsAnswered: myScore.questionsAnswered });
  } catch (e) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

// =============================================
// WILDCARD ROUTE — ต้องอยู่หลัง API routes ทั้งหมด!
// ถ้าวางก่อนจะทำให้ /api/* ได้รับ HTML แทน JSON
// =============================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

// =============================================
// MULTIPLAYER SOCKET.IO — ระบบเล่นหลายคน
// =============================================
const rooms = new Map();   // เก็บข้อมูลห้องทั้งหมด
const players = new Map(); // เก็บข้อมูลผู้เล่นแต่ละ socket
const feedbackCooldown = new Map(); // ป้องกัน feedback spam

// สุ่มรหัสห้อง 5 ตัวอักษรที่ไม่ซ้ำกัน
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); } while (rooms.has(code));
  return code;
}

// เรียงคำถามตาม level (ง่าย→ยาก) แล้วสุ่มภายใน level เดียวกัน
function sortAndShuffleByLevel(pool) {
  const grouped = {};
  pool.forEach(q => { if (!grouped[q.level]) grouped[q.level] = []; grouped[q.level].push(q); });
  let finalPool = [];
  Object.keys(grouped).sort((a, b) => a - b).forEach(lvl => {
    let arr = grouped[lvl];
    // Fisher-Yates shuffle ภายใน level เดียวกัน
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    finalPool = finalPool.concat(arr);
  });
  return finalPool;
}

const QUESTIONS = require('./data/questions');

// เลือกคำถามตาม mode และจัดเรียง
function getQuestions(mode) {
  let pool = mode === 'SURVIVAL' ? QUESTIONS.filter(q => q.level >= 6) : QUESTIONS.filter(q => q.mode === mode);
  if (!pool.length) pool = QUESTIONS;
  return sortAndShuffleByLevel(pool);
}

// แปลง question object เป็นรูปแบบที่ส่งไป client (ไม่ส่ง answer)
function serializeQuestion(q) { if (!q) return null; return { id: q.id, text: q.text, code: q.code, mode: q.mode, level: q.level }; }

// แปลง room เป็นรูปแบบที่ส่งไป client
function serializeRoom(room) {
  const playerList = [];
  room.players.forEach(p => { playerList.push({ socketId: p.socketId, name: p.name, score: p.score, hp: p.hp, ready: p.ready, done: p.done, combo: p.combo || 0 }); });
  return { code: room.code, hostId: room.hostId, mode: room.mode, timeLimit: room.timeLimit, status: room.status, players: playerList.sort((a, b) => b.score - a.score) };
}

// สร้าง scoreboard เรียงตามคะแนน
function getScoreboard(room) {
  const arr = [];
  room.players.forEach(p => { arr.push({ socketId: p.socketId, name: p.name, score: p.score, hp: p.hp, done: p.done, rank: p.rank, combo: p.combo || 0 }); });
  return arr.sort((a, b) => b.score - a.score);
}

// นับจำนวนผู้เล่นที่เล่นเสร็จแล้ว (HP หมดหรือเสร็จ)
function countDone(room) { let c = 0; room.players.forEach(p => { if (p.done) c++; }); return c; }

// เริ่ม timer countdown ส่ง tick ทุกวินาที
function startRoomTimer(room, roomCode) {
  clearRoomTimer(room);
  room.timerInterval = setInterval(() => {
    room.globalTimer--; io.to(roomCode).emit('timer_tick', { time: room.globalTimer });
    if (room.globalTimer <= 0) { clearRoomTimer(room); endGame(room, roomCode, 'timeout'); }
  }, 1000);
}

// หยุด timer
function clearRoomTimer(room) { if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; } }

// ตรวจสอบว่าทุกคนเล่นเสร็จหรือยัง
function checkAllDone(room, roomCode) {
  let allDone = true; room.players.forEach(p => { if (!p.done) allDone = false; });
  if (allDone && room.status === 'playing') { clearRoomTimer(room); endGame(room, roomCode, 'all_done'); }
}

// จบเกม ส่ง scoreboard และ reset ห้องหลัง 2 วินาที
function endGame(room, roomCode, reason) {
  if (room.status === 'ended') return; room.status = 'ended';
  const scoreboard = getScoreboard(room);
  scoreboard.forEach((p, i) => { const rp = room.players.get(p.socketId); if (rp && !rp.done) rp.rank = i + 1; });
  io.to(roomCode).emit('game_ended', { scoreboard, reason });
  // reset ห้องกลับเป็น waiting หลัง 2 วินาที
  setTimeout(() => {
    if (rooms.has(roomCode)) { room.status = 'waiting'; room.players.forEach(p => { p.ready = false; p.done = false; }); io.to(roomCode).emit('room_update', serializeRoom(room)); }
  }, 2000);
  // ลบห้องที่ไม่มีคนอยู่หลัง 15 นาที
  setTimeout(() => {
    if (rooms.has(roomCode) && rooms.get(roomCode).status === 'waiting' && rooms.get(roomCode).players.size === 0) { clearRoomTimer(room); rooms.delete(roomCode); }
  }, 15 * 60 * 1000);
}

// จัดการ Socket.IO events ทั้งหมด
io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  // สร้างห้องใหม่
  socket.on('create_room', ({ playerName, mode, timeLimit }) => {
    const code = generateRoomCode(); const tl = parseInt(timeLimit) || 60; const itemsMap = { 60: 1, 120: 2, 180: 3 };
    const room = { code, hostId: socket.id, mode: mode || 'BASICS', timeLimit: tl, defaultItems: itemsMap[tl] || 1, status: 'waiting', players: new Map(), questions: [], questionIndex: 0, startTime: null, timerInterval: null, globalTimer: tl };
    const player = { socketId: socket.id, name: (playerName || 'PLAYER').toUpperCase().slice(0, 12), score: 0, hp: 100, combo: 0, hints: room.defaultItems, potions: room.defaultItems, skips: room.defaultItems, ready: false, done: false, rank: null };
    room.players.set(socket.id, player); rooms.set(code, room); players.set(socket.id, { roomCode: code, name: player.name });
    socket.join(code);
    socket.emit('room_created', { roomCode: code, mode: room.mode, timeLimit: room.timeLimit, isHost: true });
    socket.emit('room_update', serializeRoom(room));
  });

  // เข้าร่วมห้องที่มีอยู่
  socket.on('join_room', ({ playerName, roomCode }) => {
    const code = roomCode?.toUpperCase().trim(); const room = rooms.get(code);
    if (!room) return socket.emit('error_msg', 'ไม่พบห้อง — ตรวจสอบรหัสอีกครั้ง');
    if (room.status !== 'waiting') return socket.emit('error_msg', 'เกมเริ่มแล้ว ไม่สามารถเข้าร่วมได้');
    if (room.players.size >= 8) return socket.emit('error_msg', 'ห้องเต็มแล้ว (สูงสุด 8 คน)');
    const player = { socketId: socket.id, name: (playerName || 'PLAYER').toUpperCase().slice(0, 12), score: 0, hp: 100, combo: 0, hints: room.defaultItems, potions: room.defaultItems, skips: room.defaultItems, ready: false, done: false, rank: null };
    room.players.set(socket.id, player); players.set(socket.id, { roomCode: code, name: player.name });
    socket.join(code);
    socket.emit('room_joined', { roomCode: code, mode: room.mode, timeLimit: room.timeLimit, isHost: false });
    io.to(code).emit('room_update', serializeRoom(room));
    io.to(code).emit('chat_msg', { system: true, text: `${player.name} เข้าร่วมห้อง!` });
  });

  // กด Ready / ยกเลิก Ready
  socket.on('player_ready', () => {
    const info = players.get(socket.id); if (!info) return;
    const room = rooms.get(info.roomCode); if (!room || room.status !== 'waiting') return;
    const player = room.players.get(socket.id); if (!player) return;
    player.ready = !player.ready;
    io.to(info.roomCode).emit('room_update', serializeRoom(room));
  });

  // Host กด Start Game
  socket.on('start_game', () => {
    const info = players.get(socket.id); if (!info) return;
    const room = rooms.get(info.roomCode); if (!room || room.hostId !== socket.id) return;
    if (room.players.size < 1 || room.status !== 'waiting') return;
    room.status = 'playing'; room.questions = getQuestions(room.mode);
    room.questionIndex = 0; room.globalTimer = room.timeLimit; room.startTime = Date.now();
    room.players.forEach(p => { p.score = 0; p.hp = 100; p.combo = 0; p.done = false; p.rank = null; p.questionIndex = 0; p.hints = room.defaultItems; p.potions = room.defaultItems; p.skips = room.defaultItems; });
    io.to(info.roomCode).emit('game_started', { mode: room.mode, timeLimit: room.timeLimit, question: serializeQuestion(room.questions[0]), defaultItems: room.defaultItems });
    startRoomTimer(room, info.roomCode);
  });

  // ส่งคำตอบ ตรวจสอบและให้คะแนน
  socket.on('submit_answer', ({ answer }) => {
    const info = players.get(socket.id); if (!info) return;
    const room = rooms.get(info.roomCode); if (!room || room.status !== 'playing') return;
    const player = room.players.get(socket.id); if (!player || player.done) return;
    const qIdx = player.questionIndex !== undefined ? player.questionIndex : 0;
    const question = room.questions[qIdx % room.questions.length]; if (!question) return;
    const correct = question.ans.toLowerCase().trim(); const given = (answer || '').toLowerCase().trim();
    if (given === correct) {
      player.combo = (player.combo || 0) + 1;
      // คะแนนพื้นฐาน + โบนัส combo
      const earned = 150 + (player.combo >= 5 ? 75 : player.combo >= 3 ? 50 : 0);
      player.score += earned; player.questionIndex = (qIdx + 1) % room.questions.length;
      socket.emit('answer_result', { correct: true, earned, combo: player.combo, score: player.score, timeBonusGiven: player.combo % 3 === 0, nextQuestion: serializeQuestion(room.questions[player.questionIndex]) });
    } else {
      player.combo = 0; player.hp = Math.max(0, player.hp - 20);
      socket.emit('answer_result', { correct: false, hp: player.hp, combo: 0, score: player.score });
      if (player.hp <= 0) { player.done = true; player.rank = countDone(room); socket.emit('player_eliminated', { score: player.score }); }
    }
    io.to(info.roomCode).emit('score_update', getScoreboard(room)); checkAllDone(room, info.roomCode);
  });

  // ใช้ไอเทม (hint / potion / skip)
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

  // ส่งข้อความแชทในห้อง
  socket.on('send_chat', ({ text }) => {
    const info = players.get(socket.id); if (!info || !text) return;
    const msg = text.trim().slice(0, 80); if (!msg) return;
    io.to(info.roomCode).emit('chat_msg', { name: info.name, text: msg });
  });

  // ส่ง feedback ไปยัง Discord webhook
  socket.on('send_feedback', async (data) => {
    try {
      const now = Date.now(); const lastTime = feedbackCooldown.get(socket.id) || 0;
      if (now - lastTime < 3000) return socket.emit('feedback_error', 'ส่งถี่เกินไป รอ 3 วินาที');
      feedbackCooldown.set(socket.id, now);
      const msg = data?.message || 'ไม่มีข้อความ'; const senderName = data?.name || 'ไม่ระบุชื่อ';
      const url = process.env.DISCORD_WEBHOOK_URL || '';
      if (url) await axios.post(url, { content: `📩 **FEEDBACK REPORT**\n**👤 จาก:** ${senderName}\n**📝 ข้อความ:** ${msg}` });
      socket.emit('feedback_success');
    } catch (err) { socket.emit('feedback_error', 'ระบบเซิร์ฟเวอร์ขัดข้อง: ' + err.message); }
  });

  // ผู้เล่น disconnect — ล้างข้อมูลออกจากห้อง
  socket.on('disconnect', () => {
    feedbackCooldown.delete(socket.id);
    const info = players.get(socket.id); if (!info) return;
    const room = rooms.get(info.roomCode); players.delete(socket.id); if (!room) return;
    room.players.delete(socket.id);
    io.to(info.roomCode).emit('chat_msg', { system: true, text: `${info.name} ออกจากห้อง` });
    // ถ้าไม่มีคนเหลือ ลบห้อง
    if (room.players.size === 0) { clearRoomTimer(room); rooms.delete(info.roomCode); return; }
    // ถ้า host ออก ส่งต่อ host ให้คนถัดไป
    if (room.hostId === socket.id) { room.hostId = room.players.keys().next().value; io.to(room.hostId).emit('you_are_host'); }
    io.to(info.roomCode).emit('room_update', serializeRoom(room)); checkAllDone(room, info.roomCode);
  });
});

// =============================================
// START SERVER — เริ่มฟัง port
// =============================================
const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => {
  console.log(`\n🐍 PYTHON HUNTER v4 SERVER`);
  console.log(`   Running on port ${PORT}`);
  console.log(`   MongoDB: ${MONGO_URI ? 'enabled' : 'disabled (set MONGO_URI in env)'}`);
});
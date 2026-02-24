# 🐍 PYTHON HUNTER v4 — ULTIMATE EDITION

เกม Python Syntax Quiz แบบ Multiplayer Realtime  
รองรับ Solo + Online Multiplayer สูงสุด 8 คน/ห้อง

---

## 📁 โครงสร้างไฟล์

```
python-hunter-v4/
├── package.json
├── render.yaml
├── README.md
├── client/
│   └── index.html        ← Frontend ทั้งหมด (HTML+CSS+JS)
└── server/
    ├── server.js         ← Node.js + Socket.IO Backend
    └── data/
        └── questions.js  ← คลังคำถาม (server-side)
```

---

## 🚀 Deploy บน Render.com

### วิธีที่ 1 — Auto Deploy (แนะนำ)

1. Push โค้ดขึ้น GitHub
2. ไปที่ [render.com](https://render.com) → New → Web Service
3. เลือก repository ของคุณ
4. Render จะอ่าน `render.yaml` อัตโนมัติ
5. กด Deploy!

### วิธีที่ 2 — Manual Settings

| Setting | Value |
|---------|-------|
| Environment | Node |
| Build Command | `npm install` |
| Start Command | `node server/server.js` |
| Port | `10000` (auto จาก env PORT) |

---

## 💻 รันบน Local

```bash
# ติดตั้ง dependencies
npm install

# รัน server
npm start
# หรือ
node server/server.js

# เปิดเบราว์เซอร์ที่
http://localhost:3000
```

---

## 🎮 วิธีเล่น Multiplayer

1. **Host** — ใส่ชื่อ → แท็บ MULTIPLAYER → สร้างห้อง → เลือก Mode → แชร์รหัส 5 ตัว
2. **Guest** — ใส่ชื่อ → แท็บ MULTIPLAYER → เข้าร่วม → ใส่รหัส → กด Ready
3. **Host** กด START GAME เมื่อทุกคนพร้อม
4. แข่งกันตอบคำถาม Python ให้ได้คะแนนมากที่สุด!
5. หลังจบ → ดู Final Ranking พร้อมคะแนนทุกคน

---

## ⚡ Features

- **Solo Mode** — 6 โมดูล + Survival Hardcore
- **Multiplayer** — สูงสุด 8 คน/ห้อง, Realtime Score, Live Leaderboard
- **Sound Engine** — Web Audio API เสียงสมจริงทุก action  
- **Particle FX** — อนุภาคทุกครั้งที่ตอบถูก
- **Responsive** — รองรับมือถือ, แท็บเล็ต, คอม
- **Combo System** — ×3 = +10s, ×5 = +HP
- **Power-ups** — 💊 HP | 💡 Hint | ⏩ Skip

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla JS + CSS3 (single file) |
| Backend | Node.js + Express |
| Realtime | Socket.IO v4 |
| Deploy | Render.com |
| Fonts | Google Fonts (Orbitron + Share Tech Mono) |

---

DEV: PANAKAPOL & KONGPHOP

const { createServer } = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { AccessToken } = require('livekit-server-sdk'); // 👈 SDK tạo token LiveKit

// ==========================================
// 🧠 KHO LƯU TRỮ TRẠNG THÁI TRÊN RAM (IN-MEMORY STATE)
// ==========================================
const rooms = {};

// ==========================================================================
// 🏰 [ĐÃ VÁ] CÔNG THỨC NÂNG CẤP NHÀ: KHÔNG CÒN HARDCODE CỨNG NỮA
// Server giờ tự fetch + parse CÙNG 1 FILE CSV mà Client đang dùng, để 2 bên
// luôn khớp tuyệt đối, và tự động hỗ trợ MỌI cấp có trong Sheet (không giới hạn).
// ==========================================================================
const UPGRADE_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vT-EFZn4iPTyVHW35NtYDWCwVH5mt6Vuw9kbAFNMm8CkLXzu31QdoK7vW18NdlKLXKKgZIH9YYFKqoh/pub?gid=1657520732&single=true&output=csv";

let UPGRADE_FORMULAS_DYNAMIC = {};
let _formulasReady = false;

/**
 * Cấu trúc cột thật của Sheet (đã xác nhận qua ảnh chụp):
 * A=Level, B-E=Item1-4 ("item_xxx:soLuong"), F=Xu farm (yêu cầu),
 * G=Xu (thưởng xu thường cá nhân), H=Xu Upgrade (thưởng xu nâng cấp cá nhân),
 * I=Phần thưởng extra (item bonus, có thể trống)
 */
function parseUpgradeFormulaCSV(csvText) {
  const parsed = {};
  const lines = csvText.split(/\r?\n/).filter(l => l.trim() !== "");

  for (let i = 1; i < lines.length; i++) {
    const matches = lines[i].match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || [];
    const values = matches.map(v => v.trim().replace(/^"|"$/g, ""));
    if (values.length < 1) continue;

    const lvKey = values[0];
    const items = [];
    const amounts = [];

    // 🎯 CHỈ 4 CỘT ITEM THẬT SỰ (index 1 -> 4), KHÔNG PHẢI 5 NHƯ CODE CŨ
    for (let col = 1; col <= 4; col++) {
      const raw = values[col];
      if (raw && raw.includes(":")) {
        const tokens = raw.split(":");
        const itemName = tokens[0].trim().replace(/^item_/, "");
        const amt = parseInt(tokens[1]) || 0;
        if (amt > 0) {
          items.push(itemName);
          amounts.push(amt);
        }
      }
    }

    const reqFarmCoin = parseInt(values[5]) || 0;        // Cột F - Xu farm
    const rewardCoin = parseInt(values[6]) || 0;          // Cột G - Xu (thưởng cá nhân)
    const rewardUpgradeCoin = parseInt(values[7]) || 0;    // Cột H - Xu Upgrade
    const rewardExtraItem = values[8] ? values[8].trim() : ""; // Cột I - Phần thưởng extra

    parsed[lvKey] = { items, amounts, reqFarmCoin, rewardCoin, rewardUpgradeCoin, rewardExtraItem };
  }

  return parsed;
}

async function refreshUpgradeFormulas() {
  try {
    const res = await fetch(UPGRADE_CSV_URL);
    const csvText = await res.text();
    const parsed = parseUpgradeFormulaCSV(csvText);

    if (Object.keys(parsed).length > 0) {
      UPGRADE_FORMULAS_DYNAMIC = parsed;
      _formulasReady = true;
      console.log(`✅ [Upgrade Formula] Đã nạp/refresh ${Object.keys(parsed).length} cấp công thức nâng cấp từ Sheet.`);
    } else {
      console.warn("⚠️ [Upgrade Formula] Sheet trả về rỗng, giữ nguyên bản cache cũ.");
    }
  } catch (err) {
    console.error("🚨 [Upgrade Formula] Lỗi tải công thức nâng cấp từ Sheet:", err);
  }
}

// Nạp ngay khi server khởi động, và tự refresh mỗi 5 phút để không cần restart khi fen sửa Sheet
refreshUpgradeFormulas();
setInterval(refreshUpgradeFormulas, 5 * 60 * 1000);
// ==========================================================================

// Đọc địa chỉ link mây Worker từ biến môi trường Render đã setup
const CF_WORKER_URL = process.env.CF_WORKER_URL || "https://sync-sheet-worker.kyuu2601.workers.dev";

// ==========================================
// 🎙️ THÔNG SỐ LIVEKIT VOICE
// ==========================================
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL || "wss://mon-english-y39l53ic.livekit.cloud";

// ==========================================
// 🛡️ HẠ TẦNG HTTP SERVER BẢO HIỂM CHO RENDER.COM
// ==========================================
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (reqUrl.pathname === '/voice-token') {
    const room = reqUrl.searchParams.get('room');
    const username = reqUrl.searchParams.get('username');

    if (!room || !username) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Thiếu room hoặc username' }));
      return;
    }

    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server chưa cấu hình LIVEKIT_API_KEY / LIVEKIT_API_SECRET' }));
      return;
    }

    try {
      const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity: username,
        ttl: '4h',
      });
      at.addGrant({
        roomJoin: true,
        room: room,
        canPublish: true,
        canSubscribe: true,
      });

      const token = await at.toJwt();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token, url: LIVEKIT_URL }));
    } catch (err) {
      console.error('🚨 [Voice Token] Lỗi tạo token:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Tạo token thất bại' }));
    }
    return;
  }

  // 🆕 Route debug nhanh xem cấu hình công thức nâng cấp đã nạp đúng chưa
  if (reqUrl.pathname === '/debug/upgrade-formulas') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ready: _formulasReady, formulas: UPGRADE_FORMULAS_DYNAMIC }, null, 2));
    return;
  }

  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('Sảnh mạng Mon English Realtime đang thông suốt rực rỡ!');
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server });

// ==========================================
// 📡 ĐƯỜNG ỐNG TIẾP NHẬN MẠCH KẾT NỐI WEBSOCKET
// ==========================================
wss.on('connection', (ws, req) => {
  const urlParts = req.url.split('/');
  const roomId = urlParts[urlParts.length - 1] || 'global_room_01';

  let myUsername = null;

  console.log(`🌐 [Kết nối mới] Một thiết bị vừa cắm rắc vào đường ống phòng: ${roomId}`);

  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);

      switch (msg.action) {
        case 'join': {
          myUsername = msg.uid;
          const skinId = msg.skin || 'Avatar_1';

          if (!rooms[roomId]) {
            rooms[roomId] = {
              house_level: 1,
              farm_coins: 0,
              inventory: {},
              players: {},
              room_members: [],
              isLoadedFromD1: false,
              loadingPromise: null
            };
          }

          const room = rooms[roomId];

          if (!room.isLoadedFromD1) {
            if (!room.loadingPromise) {
              room.loadingPromise = fetch(`${CF_WORKER_URL}/api/farm-world?room_id=${roomId}`)
                .then(res => res.json())
                .then(json => {
                  if (json.success && json.data) {
                    room.house_level = parseInt(json.data.house_level) || 1;
                    room.farm_coins = parseInt(json.data.farm_coins) || 0;
                    room.room_members = json.data.room_members || [];

                    try {
                      room.inventory = typeof json.data.inventory === 'string' ? JSON.parse(json.data.inventory) : (json.data.inventory || {});
                    } catch (e) {
                      room.inventory = {};
                    }
                    console.log(`📦 [D1 LOAD OK] Đã hốt trọn dữ liệu phòng ${roomId} kèm ${room.room_members.length} thành viên lên RAM Render!`);
                  } else {
                    console.warn(`⚠️ [D1 LOAD FAIL] Worker từ chối cấp dữ liệu gốc phòng ${roomId}:`, json.message || "Không rõ lý do");
                  }
                  room.isLoadedFromD1 = true;
                })
                .catch(err => {
                  console.error(`🚨 [D1 LOAD ERROR] Lỗi bốc dữ liệu phòng ${roomId}, dùng tạm mặc định:`, err);
                  room.isLoadedFromD1 = true;
                });
            }
            await room.loadingPromise;
          }

          const myD1Members = room.room_members.find(m => m.username && m.username.toString().trim() === myUsername.toString().trim());
          const liveFarmEnergy = (myD1Members && myD1Members.farm_energy !== null && myD1Members.farm_energy !== undefined) ? parseInt(myD1Members.farm_energy) : 100;
          const liveUserCoins = (myD1Members && myD1Members.coins !== null && myD1Members.coins !== undefined) ? parseInt(myD1Members.coins) : 0;

          room.players[myUsername] = {
            ws: ws,
            uid: myUsername,
            skin: skinId,
            x: 0,
            farm_energy: liveFarmEnergy,
            coins: liveUserCoins
          };

          const activePlayersList = Object.values(room.players).map(p => ({
            uid: p.uid,
            skin: p.skin,
            x: p.x
          }));

          ws.send(JSON.stringify({
            action: 'sync_room_state',
            house_level: room.house_level,
            inventory: room.inventory,
            farm_coins: room.farm_coins,
            active_players: activePlayersList,
            room_members: room.room_members,
            farm_energy: room.players[myUsername].farm_energy,
            coins: room.players[myUsername].coins
          }));

          broadcastToRoom(roomId, myUsername, {
            action: 'user_joined',
            uid: myUsername,
            skin: skinId,
            x: 0
          });
          break;
        }

        case 'move': {
          if (!myUsername || !rooms[roomId]) return;
          const room = rooms[roomId];
          const player = room.players[myUsername];
          if (!player) return;

          player.x = msg.x;

          broadcastToRoom(roomId, myUsername, {
            action: 'user_moved',
            uid: myUsername,
            x: msg.x,
            dirX: msg.dirX
          });
          break;
        }

        case 'add_item': {
          if (!myUsername || !rooms[roomId]) return;
          const room = rooms[roomId];
          const itemId = msg.item_id;

          if (!itemId) return;

          room.inventory[itemId] = (room.inventory[itemId] || 0) + 1;

          const quizScore = parseInt(msg.score) || 0;
          const bonusCoins = quizScore * 10;
          room.farm_coins += bonusCoins;

          console.log(`🪙 [Hạch toán] Học sinh [${myUsername}] làm đúng ${quizScore} câu -> Tặng quỹ phòng +${bonusCoins} Xu Farm. Số dư két hiện tại: ${room.farm_coins}`);

          broadcastToRoom(roomId, null, {
            action: 'inventory_updated',
            inventory: room.inventory,
            farm_coins: room.farm_coins
          });

          saveRoomToD1Background(roomId, room, myUsername, 0, false, 0);
          break;
        }

        case 'sync_user_tool': {
          if (!myUsername || !rooms[roomId]) return;
          msg.uid = myUsername;
          broadcastToRoom(roomId, myUsername, msg);
          break;
        }

        case 'sync_user_vfx': {
          if (!myUsername || !rooms[roomId]) return;
          msg.uid = myUsername;
          broadcastToRoom(roomId, myUsername, msg);
          break;
        }

        case 'sync_voice_status': {
          if (!myUsername || !rooms[roomId]) return;
          msg.uid = myUsername;
          broadcastToRoom(roomId, myUsername, msg);
          break;
        }

        // ==========================================================================
        // 🏰 [ĐÃ VÁ TOÀN BỘ] MẠCH NÂNG CẤP NHÀ:
        // - Dùng công thức ĐỘNG từ Sheet (hỗ trợ vô hạn cấp, không còn dừng ở cấp 3)
        // - Kiểm tra ĐẦY ĐỦ cả nguyên liệu VÀ Xu farm (trước đây bỏ qua Xu farm)
        // - Nếu thất bại: PHẢN HỒI RÕ LÝ DO về đúng người bấm, không còn im lặng
        // - Thưởng cả Xu thường VÀ Xu Upgrade cho toàn bộ thành viên
        // ==========================================================================
        case 'upgrade_house': {
          if (!myUsername || !rooms[roomId]) return;
          const room = rooms[roomId];
          const currentLv = room.house_level;
          const formula = UPGRADE_FORMULAS_DYNAMIC[currentLv.toString()];

          if (!formula) {
            ws.send(JSON.stringify({
              action: 'upgrade_failed',
              reason: _formulasReady
                ? 'Nhà đã đạt cấp tối đa hiện có trong cấu hình Sheet!'
                : 'Hệ thống công thức nâng cấp chưa tải xong, thử lại sau ít giây!'
            }));
            console.warn(`⚠️ [Nâng cấp] [${myUsername}] yêu cầu nâng cấp cấp ${currentLv}, nhưng không tìm thấy công thức (formulasReady=${_formulasReady}).`);
            return;
          }

          // Kiểm tra nguyên liệu
          let missingParts = [];
          for (let i = 0; i < formula.items.length; i++) {
            const reqItem = formula.items[i];
            const reqAmount = formula.amounts[i];
            const currentStock = room.inventory[reqItem] || 0;
            if (currentStock < reqAmount) {
              missingParts.push(`${reqItem} (${currentStock}/${reqAmount})`);
            }
          }

          // 🆕 Kiểm tra Xu Farm (TRƯỚC ĐÂY SERVER BỎ QUA HOÀN TOÀN ĐIỀU KIỆN NÀY)
          if (room.farm_coins < formula.reqFarmCoin) {
            missingParts.push(`Xu Farm (${room.farm_coins}/${formula.reqFarmCoin})`);
          }

          if (missingParts.length > 0) {
            ws.send(JSON.stringify({
              action: 'upgrade_failed',
              reason: `Chưa đủ điều kiện nâng cấp! Còn thiếu: ${missingParts.join(', ')}`
            }));
            console.warn(`⚠️ [Nâng cấp] [${myUsername}] thiếu điều kiện: ${missingParts.join(', ')}`);
            return;
          }

          // ✅ Đủ điều kiện -> Khấu trừ nguyên liệu + Xu farm
          for (let i = 0; i < formula.items.length; i++) {
            room.inventory[formula.items[i]] -= formula.amounts[i];
          }
          room.farm_coins -= formula.reqFarmCoin;
          room.house_level += 1;

          const rewardCoins = formula.rewardCoin || 0;
          const rewardUpgradeCoins = formula.rewardUpgradeCoin || 0;

          console.log(`🏰 [NÂNG CẤP GUILD] [${myUsername}] nâng nhà lên cấp ${room.house_level}. Thưởng +${rewardCoins} Xu, +${rewardUpgradeCoins} Xu Upgrade cho toàn bộ thành viên!`);

          if (room.room_members && Array.isArray(room.room_members)) {
            room.room_members.forEach(member => {
              if (member) {
                member.coins = (parseInt(member.coins) || 0) + rewardCoins;
                member.upgrade_coins = (parseInt(member.upgrade_coins) || 0) + rewardUpgradeCoins;
              }
            });
          }

          for (const username in room.players) {
            if (room.players[username]) {
              room.players[username].coins = (parseInt(room.players[username].coins) || 0) + rewardCoins;
            }
          }

          // 🎁 Phần thưởng extra (item bonus, nếu cột I có giá trị)
          if (formula.rewardExtraItem) {
            const extraItemKey = formula.rewardExtraItem.replace(/^item_/, "");
            room.inventory[extraItemKey] = (room.inventory[extraItemKey] || 0) + 1;
          }

          const activePlayersList = Object.values(room.players).map(p => ({
            uid: p.uid,
            skin: p.skin,
            x: p.x
          }));

          broadcastToRoom(roomId, null, {
            action: 'sync_room_state',
            house_level: room.house_level,
            inventory: room.inventory,
            farm_coins: room.farm_coins,
            active_players: activePlayersList,
            room_members: room.room_members
          });

          saveRoomToD1Background(roomId, room, myUsername, rewardCoins, true, rewardUpgradeCoins);
          break;
        }
      }
    } catch (err) {
      console.error('🚨 Lỗi xử lý luồng gói tin gói mạng:', err);
    }
  });

  ws.on('close', () => {
    if (myUsername && rooms[roomId] && rooms[roomId].players[myUsername]) {
      delete rooms[roomId].players[myUsername];
      console.log(`🔌 [Thoát phòng] Bạn học [${myUsername}] đã ngắt kết nối rời sảnh.`);

      broadcastToRoom(roomId, null, {
        action: 'user_left',
        uid: myUsername
      });

      if (Object.keys(rooms[roomId].players).length === 0) {
        delete rooms[roomId];
        console.log(`🧹 [Giải phóng RAM] Phòng ${roomId} không còn ai chơi, dọn dẹp bộ nhớ sạch bách.`);
      }
    }
  });
});

// ==========================================
// 🛠️ CÁC HÀM PHỤ TRỢ ĐIỀU PHỐI ĐƯỜNG TRUYỀN SIÊU TỐC
// ==========================================

function broadcastToRoom(roomId, excludeUsername, packetObj) {
  const room = rooms[roomId];
  if (!room || !room.players) return;

  const payload = JSON.stringify(packetObj);
  for (const username in room.players) {
    if (username === excludeUsername) continue;
    const client = room.players[username];
    if (client.ws && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

// 🆕 Thêm tham số upgradeCoinsEarned để đẩy luôn phần thưởng Xu Upgrade xuống D1
function saveRoomToD1Background(roomId, room, upgradeUser = null, coinsEarned = 0, isGuildReward = false, upgradeCoinsEarned = 0) {
  fetch(`${CF_WORKER_URL}/api/farm-world/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room_id: roomId,
      house_level: room.house_level,
      farm_coins: room.farm_coins,
      inventory: room.inventory,
      upgrade_user: upgradeUser,
      is_guild_reward: isGuildReward,
      reward_coins: coinsEarned,
      reward_upgrade_coins: upgradeCoinsEarned // 👈 MỚI
    })
  })
  .then(res => res.json())
  .then(json => {
    if (json.success) {
      console.log(`✅ [Write-Behind Thành công] DB D1 đồng bộ và lưu trữ hoàn tất tài sản phòng ${roomId}. Thưởng Guild: ${isGuildReward}`);
    } else {
      console.error(`❌ [Write-Behind BỊ TỪ CHỐI] Worker báo lỗi xử lý D1:`, json.message);
    }
  })
  .catch(err => console.error(`🚨 [Write-Behind SẬP MẠCH] Lỗi kết nối HTTP nối sang Worker:`, err));
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Sảnh mạng Realtime Node.js cất cánh hoàn hảo tại cổng: ${PORT}`);
});

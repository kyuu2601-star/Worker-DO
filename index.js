const { createServer } = require('http');
const { WebSocketServer, WebSocket } = require('ws');

// ==========================================
// 🧠 KHO LƯU TRỮ TRẠNG THÁI TRÊN RAM (IN-MEMORY STATE)
// Đảm bảo truy xuất tốc độ vài mili-giây, triệt tiêu delay Disk I/O
// ==========================================
const rooms = {};

// Cấu hình công thức nâng cấp nhà chung đồng bộ 100% với Frontend Cocos
const UPGRADE_FORMULAS = {
  1: { items: ["wood_log", "mine_stone"], amounts: [4, 4] },
  2: { items: ["wood_log", "mine_iron", "crop_potato"], amounts: [10, 5, 8] },
  3: { items: ["mine_gold", "meat_beef", "fast_pizza"], amounts: [5, 10, 5] }
};

// Đọc địa chỉ link mây Worker từ biến môi trường Render đã setup
const CF_WORKER_URL = process.env.CF_WORKER_URL || "https://sync-sheet-worker.kyuu2601.workers.dev";

// ==========================================
// 🛡️ HẠ TẦNG HTTP SERVER BẢO HIỂM CHO RENDER.COM
// Render Free yêu cầu phải phản hồi cổng HTTP để nghiệm thu (Health Check)
// ==========================================
const server = createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('Sảnh mạng Mon English Realtime đang thông suốt rực rỡ!');
  } else {
    res.writeHead(404);
  }
});

const wss = new WebSocketServer({ server });

// ==========================================
// 📡 ĐƯỜNG ỐNG TIẾP NHẬN MẠCH KẾT NỐI WEBSOCKET
// ==========================================
wss.on('connection', (ws, req) => {
  // Trích xuất worldId (roomId) từ URL đường dẫn của Cocos bắn lên (Ví dụ: /farm-ws/global_room_01)
  const urlParts = req.url.split('/');
  const roomId = urlParts[urlParts.length - 1] || 'global_room_01';
  
  let myUsername = null;

  console.log(`🌐 [Kết nối mới] Một thiết bị vừa cắm rắc vào đường ống phòng: ${roomId}`);

  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);
      
      switch (msg.action) {
        // 🚀 MẠCH 1: KHAI BÁO DANH TÍNH VÀ JOIN PHÒNG CHƠI CHUNG
        case 'join': {
          myUsername = msg.uid;
          const skinId = msg.skin || 'Avatar_1';

          // Khởi tạo thực thể phòng trên RAM sảnh nếu chưa từng tồn tại
          if (!rooms[roomId]) {
            rooms[roomId] = {
              house_level: 1,
              farm_coins: 0,
              inventory: {},
              players: {},
              room_members: [], // 🆕 THÊM BIẾN ĐỆM TRÊN RAM: Lưu danh sách 4 đứa từ D1
              isLoadedFromD1: false,
              loadingPromise: null
            };
          }

          const room = rooms[roomId];

          // Cơ chế kéo dữ liệu gốc từ D1 lên RAM khi phòng vừa được tạo lần đầu
          if (!room.isLoadedFromD1) {
            if (!room.loadingPromise) {
              room.loadingPromise = fetch(`${CF_WORKER_URL}/api/farm-world?room_id=${roomId}`)
                .then(res => res.json())
                .then(json => {
                  if (json.success && json.data) {
                    room.house_level = parseInt(json.data.house_level) || 1;
                    room.farm_coins = parseInt(json.data.farm_coins) || 0;
                    
                    // ==========================================================================
                    // 🔥 THÔNG MẠCH TRUNG CHUYỂN: Hốt danh sách thành viên D1 từ Worker về RAM Render
                    // ==========================================================================
                    room.room_members = json.data.room_members || [];
                    // ==========================================================================

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

          // ==========================================================================
          // 🛠️ ĐỊNH VỊ THỂ LỰC CÁ NHÂN: Truy quét bình năng lượng mới nhất từ mảng dữ liệu D1
          // ==========================================================================
          const myD1Members = room.room_members.find(m => m.username && m.username.toString().trim() === myUsername.toString().trim());
          const liveFarmEnergy = (myD1Members && myD1Members.farm_energy !== null && myD1Members.farm_energy !== undefined) ? parseInt(myD1Members.farm_energy) : 100;
          // ==========================================================================

          // Ghim người chơi này vào danh sách nhân sự ONLINE của Room trong RAM
          room.players[myUsername] = {
            ws: ws,
            uid: myUsername,
            skin: skinId,
            x: 0,
            farm_energy: liveFarmEnergy // 👈 ĐĂNG KÝ BÌNH THỂ LỰC THỰC TẾ VÀO THỰC THỂ RAM RENDER
          };

          // Nhịp A: Trả trạng thái toàn cục của phòng về máy đứa vừa vào để Cocos vẽ Map
          const activePlayersList = Object.values(room.players).map(p => ({
            uid: p.uid,
            skin: p.skin,
            x: p.x
          }));

          // 📡 VÁ MẠCH PHÁT LOA CHÍ MẠNG: Phát loa kèm theo farm_energy cá nhân để Client đồng bộ đè đắp HUD HUD
          ws.send(JSON.stringify({
            action: 'sync_room_state',
            house_level: room.house_level,
            inventory: room.inventory,
            farm_coins: room.farm_coins,
            active_players: activePlayersList,
            room_members: room.room_members, 
            farm_energy: room.players[myUsername].farm_energy // 👈 GỬI KÈM CHỐNG DESYNC KHI ĐỔI SẢNH MAP
          }));

          // Nhịp B: Phát loa báo cho các đứa còn lại biết để đúc xác Clone nhân vật mới
          broadcastToRoom(roomId, myUsername, {
            action: 'user_joined',
            uid: myUsername,
            skin: skinId,
            x: 0
          });
          break;
        }

        // 🕹️ MẠCH 2: ĐỒNG BỘ CHẠY CHẠY REALTIME
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

        // ==========================================================================
        // 📥 MẠCH 3: HỌC SINH NỘP ĐỒ VÀ HẠCH TOÁN NHÂN 10 TIỀN VÀO KÉT CHUNG PHÒNG CHƠI
        // ==========================================================================
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

          saveRoomToD1Background(roomId, room);
          break;
        }

        // 🏰 MẠCH 4: BẤM NÚT NÂNG CẤP NHÀ CHUNG
        case 'upgrade_house': {
          if (!myUsername || !rooms[roomId]) return;
          const room = rooms[roomId];
          const currentLv = room.house_level;
          const formula = UPGRADE_FORMULAS[currentLv];

          if (!formula) return; 

          let isSatisfied = true;
          for (let i = 0; i < formula.items.length; i++) {
            const reqItem = formula.items[i];
            const reqAmount = formula.amounts[i];
            const currentStock = room.inventory[reqItem] || 0;
            if (currentStock < reqAmount) {
              isSatisfied = false;
              break;
            }
          }

          if (isSatisfied) {
            for (let i = 0; i < formula.items.length; i++) {
              const reqItem = formula.items[i];
              room.inventory[reqItem] -= formula.amounts[i];
            }
            room.house_level += 1;

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

            saveRoomToD1Background(roomId, room);
          }
          break;
        }
      }
    } catch (err) {
      console.error('🚨 Lỗi xử lý luồng gói tin gói mạng:', err);
    }
  });

  // 🔌 MẠCH 5: NGƯỜI CHƠI ĐÓNG MÁY / ĐỨT MẠNG / THOÁT PHÒNG
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

function saveRoomToD1Background(roomId, room) {
  fetch(`${CF_WORKER_URL}/api/farm-world/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room_id: roomId,
      house_level: room.house_level,
      farm_coins: room.farm_coins,
      inventory: room.inventory
    })
  })
  .then(res => res.json())
  .then(json => {
    if (json.success) {
      console.log(`✅ [Write-Behind Thành công] Đã đồng bộ tài sản phòng ${roomId} về D1 an toàn.`);
    } else {
      console.error(`❌ [Write-Behind BỊ TỪ CHỐI] Cloudflare Worker báo lỗi lưu:`, json.message || "Không rõ lý do");
    }
  })
  .catch(err => console.error(`🚨 [Write-Behind SẬP MẠCH] Lỗi kết nối HTTP truyền tải về Cloudflare:`, err));
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Sảnh mạng Realtime Node.js cất cánh hoàn hảo tại cổng: ${PORT}`);
});

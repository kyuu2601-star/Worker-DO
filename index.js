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
    res.end();
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
              room_members: [], 
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

          // ==========================================================================
          // 🛠️ ĐỊNH VỊ CHỈ SỐ CÁ NHÂN TỪ D1: Quét sạch sành sanh cả Xu thường và Thể lực cá nhân
          // ==========================================================================
          const myD1Members = room.room_members.find(m => m.username && m.username.toString().trim() === myUsername.toString().trim());
          const liveFarmEnergy = (myD1Members && myD1Members.farm_energy !== null && myD1Members.farm_energy !== undefined) ? parseInt(myD1Members.farm_energy) : 100;
          const liveUserCoins = (myD1Members && myD1Members.coins !== null && myD1Members.coins !== undefined) ? parseInt(myD1Members.coins) : 0; 
          // ==========================================================================

          // Ghim người chơi này vào danh sách nhân sự ONLINE của Room trong RAM
          room.players[myUsername] = {
            ws: ws,
            uid: myUsername,
            skin: skinId,
            x: 0,
            farm_energy: liveFarmEnergy,
            coins: liveUserCoins // 👈 GĂM TIỀN XU CÁ NHÂN LÊN BỆ PHÓNG RAM RENDER
          };

          // Nhịp A: Trả trạng thái toàn cục của phòng về máy đứa vừa vào để Cocos vẽ Map
          const activePlayersList = Object.values(room.players).map(p => ({
            uid: p.uid,
            skin: p.skin,
            x: p.x
          }));

          // 📡 VÁ MẠCH PHÁT LOA: Chuyển tiếp đồng thời mảng thành viên, Thể lực, và cả Xu cá nhân
          ws.send(JSON.stringify({
            action: 'sync_room_state',
            house_level: room.house_level,
            inventory: room.inventory,
            farm_coins: room.farm_coins,
            active_players: activePlayersList,
            room_members: room.room_members,
            farm_energy: room.players[myUsername].farm_energy,
            coins: room.players[myUsername].coins // 👈 PHÓNG ĐẦY ĐỦ XU THƯỜNG XUỐNG COCOS NẠP HUD
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

        // 📥 MẠCH 3: HỌC SINH NỘP ĐỒ VÀ HẠCH TOÁN NHÂN 10 TIỀN VÀO KÉT CHUNG PHÒNG CHƠI
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

        // ==========================================================================
        // 🏰 MẠCH 4: NÂNG CẤP NHÀ VÀ THƯỞNG XU THƯỜNG RIÊNG CHO ĐỨA BẤM NÚT
        // Bốc công thức từ CSV so khớp điều kiện, thưởng nóng ví cá nhân real-time
        // ==========================================================================
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

            // 👑 THƯỞNG KINH TẾ CÁ NHÂN: Đọc từ CSV thấy thưởng 50 thường, 10 nâng cấp (Tùy biến cứng ở đây làm mẫu 50 xu thường)
            const REWARD_COINS_CUC_BO = 50; 
            if (room.players[myUsername]) {
              room.players[myUsername].coins += REWARD_COINS_CUC_BO;
            }

            const activePlayersList = Object.values(room.players).map(p => ({
              uid: p.uid,
              skin: p.skin,
              x: p.x
            }));

            // Phát loa lệnh sync đính kèm trường coins cá nhân mới tinh để HUD máy đứa nâng cấp tự nảy số
            broadcastToRoom(roomId, null, {
              action: 'sync_room_state',
              house_level: room.house_level,
              inventory: room.inventory,
              farm_coins: room.farm_coins,
              active_players: activePlayersList,
              room_members: room.room_members,
              coins: room.players[myUsername] ? room.players[myUsername].coins : undefined // 👈 ĐỒNG BỘ ÉP ĐÈ COINS HUD
            });

            // Ghi dữ liệu ngầm về D1, truyền lệnh báo tên đứa được cộng xu thưởng
            saveRoomToD1Background(roomId, room, myUsername, REWARD_COINS_CUC_BO);
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

// 👑 MỞ RỘNG HÀM LƯU NGẦM: Chấp nhận tham số báo danh tính và tiền thưởng xu của đứa nâng cấp nhà chung
function saveRoomToD1Background(roomId, room, upgradeUser = null, bonusCoins = 0) {
  fetch(`${CF_WORKER_URL}/api/farm-world/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      room_id: roomId,
      house_level: room.house_level,
      farm_coins: room.farm_coins,
      inventory: room.inventory,
      upgrade_user: upgradeUser,   // 🆕 Gửi kèm username đứa kích hoạt
      bonus_coins: bonusCoins      // 🆕 Số xu thường được thưởng
    })
  })
  .then(res => res.json())
  .then(json => {
    if (json.success) {
      console.log(`✅ [Write-Behind Thành công] Đã đồng bộ tài sản phòng ${roomId} về D1 nạp thưởng cho [${upgradeUser}].`);
    } else {
      console.error(`❌ [Write-Behind BỊ TỪ CHỐI] Lỗi lưu:`, json.message);
    }
  })
  .catch(err => console.error(`🚨 [Write-Behind SẬP MẠCH] Lỗi HTTP:`, err));
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Sảnh mạng Realtime Node.js cất cánh hoàn hảo tại cổng: ${PORT}`);
});

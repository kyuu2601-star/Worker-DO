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

// Đọc địa chỉ link mây Worker từ biến môi trường Render đã setup ở turn trước
const CF_WORKER_URL = process.env.CF_WORKER_URL || "https://sync-sheet-worker.kyuu2601.workers.dev";

// ==========================================
// 🛡️ HẠ TẦNG HTTP SERVER BẢO HIỂM CHO RENDER.COM
// Render Free yêu cầu phải phản hồi cổng HTTP để nghiệm thu (Health Check), nếu không sẽ báo lỗi Deploy Timeout!
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
                    try {
                      room.inventory = typeof json.data.inventory === 'string' ? JSON.parse(json.data.inventory) : (json.data.inventory || {});
                    } catch (e) {
                      room.inventory = {};
                    }
                    console.log(`📦 [D1 LOAD OK] Đã hốt trọn dữ liệu phòng ${roomId} lên RAM Render!`);
                  } else {
                    console.warn(`⚠️ [D1 LOAD FAIL] Worker từ chối cấp dữ liệu gốc phòng ${roomId}:`, json.message || "Không rõ lý do");
                  }
                  room.isLoadedFromD1 = true;
                })
                .catch(err => {
                  console.error(`🚨 [D1 LOAD ERROR] Lỗi bốc dữ liệu phòng ${roomId}, dùng tạm mặc định:`, err);
                  room.isLoadedFromD1 = true; // Cho phép chạy tiếp bằng dữ liệu sảnh tạm tránh đứng hình game
                });
            }
            await room.loadingPromise;
          }

          // Ghim người chơi này vào danh sách nhân sự của Room trong RAM
          room.players[myUsername] = {
            ws: ws,
            uid: myUsername,
            skin: skinId,
            x: 0 // Vị trí xuất phát tọa độ sảnh nông trại
          };

          // Nhịp A: Trả trạng thái toàn cục của phòng về máy đứa vừa vào để Cocos vẽ Map
          const activePlayersList = Object.values(room.players).map(p => ({
            uid: p.uid,
            skin: p.skin,
            x: p.x
          }));

          ws.send(JSON.stringify({
            action: 'sync_room_state',
            house_level: room.house_level,
            inventory: room.inventory,
            active_players: activePlayersList
          }));

          // Nhịp B: Phát loa báo cho 3 đứa còn lại biết để đúc xác Clone nhân vật mới
          broadcastToRoom(roomId, myUsername, {
            action: 'user_joined',
            uid: myUsername,
            skin: skinId,
            x: 0
          });
          break;
        }

        // 🕹️ MẠCH 2: ĐỒNG BỘ CHẠY CHẠY REALTIME (TỐC ĐỘ ÁNH SÁNG)
        case 'move': {
          if (!myUsername || !rooms[roomId]) return;
          const room = rooms[roomId];
          const player = room.players[myUsername];
          if (!player) return;

          // Cập nhật bộ nhớ đệm vị trí ngay lập tức trên RAM sảnh Render
          player.x = msg.x;

          // Bắn loa vị trí cô lập ngay tức khắc cho các thành viên khác thấy real-time mượt mà
          broadcastToRoom(roomId, myUsername, {
            action: 'user_moved',
            uid: myUsername,
            x: msg.x,
            dirX: msg.dirX
          });
          break;
        }

        // 📥 MẠCH 3: HỌC SINH NỘP ĐỒ SAU KHI LÀM QUIZ XONG
        case 'add_item': {
          if (!myUsername || !rooms[roomId]) return;
          const room = rooms[roomId];
          const itemId = msg.item_id;

          if (!itemId) return;

          // Cộng dồn nông sản vào két kho đồ chung trên RAM Render
          room.inventory[itemId] = (room.inventory[itemId] || 0) + 1;

          // Báo tin vui hòm đồ thay đổi cho TOÀN BỘ thành viên sảnh nông trại múa hoạt ảnh mượt mà
          broadcastToRoom(roomId, null, {
            action: 'inventory_updated',
            inventory: room.inventory
          });

          // Kích nổ tiến trình lưu ngầm (Write-Behind Async) đẩy ngược tài sản về Cloudflare D1 bền vững
          saveRoomToD1Background(roomId, room);
          break;
        }

        // 🏰 MẠCH 4: BẤM NÚT NÂNG CẤP NHÀ CHUNG
        case 'upgrade_house': {
          if (!myUsername || !rooms[roomId]) return;
          const room = rooms[roomId];
          const currentLv = room.house_level;
          const formula = UPGRADE_FORMULAS[currentLv];

          if (!formula) return; // Đạt cấp tối đa, từ chối lệnh lậu

          // Biện pháp bảo vệ nghiêm ngặt: Kiểm tra điều kiện đủ đồ trực tiếp trên RAM Server để chống hack lậu
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
            // Khấu trừ nguyên liệu trong két RAM
            for (let i = 0; i < formula.items.length; i++) {
              const reqItem = formula.items[i];
              room.inventory[reqItem] -= formula.amounts[i];
            }
            // Lên cấp nhà
            room.house_level += 1;

            // Phát lệnh ép đồng bộ lại full sảnh cho toàn bộ người chơi để Cocos hoán đổi phôi đồ họa cấp nhà mới
            const activePlayersList = Object.values(room.players).map(p => ({
              uid: p.uid,
              skin: p.skin,
              x: p.x
            }));

            broadcastToRoom(roomId, null, {
              action: 'sync_room_state',
              house_level: room.house_level,
              inventory: room.inventory,
              active_players: activePlayersList
            });

            // Ghi dữ liệu ngầm lên Cloudflare D1
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
      // Xóa tên khỏi bộ nhớ đệm RAM sảnh
      delete rooms[roomId].players[myUsername];
      console.log(`🔌 [Thoát phòng] Bạn học [${myUsername}] đã ngắt kết nối rời sảnh.`);

      // Báo sảnh xóa xác Clone nhân vật màu vàng rực rỡ tránh rò rỉ RAM Client
      broadcastToRoom(roomId, null, {
        action: 'user_left',
        uid: myUsername
      });

      // Nếu phòng hoàn toàn trống rỗng không một bóng người, xóa luôn cache phòng giải phóng RAM cho Render
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

// Hàm phát loa truyền hình gửi tin hàng loạt trong Room
function broadcastToRoom(roomId, excludeUsername, packetObj) {
  const room = rooms[roomId];
  if (!room || !room.players) return;

  const payload = JSON.stringify(packetObj);
  for (const username in room.players) {
    if (username === excludeUsername) continue; // Bỏ qua đứa vừa gửi để tối ưu băng thông
    const client = room.players[username];
    if (client.ws && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

// Tiến trình Ghi hoãn Async (Write-Behind) bắn data về Cloudflare D1 mở xích khóa SQLite hoàn toàn ngầm
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

// Bật hạ tầng lò sưởi nguồn sảnh mạng lên mây
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Sảnh mạng Realtime Node.js cất cánh hoàn hảo tại cổng: ${PORT}`);
});

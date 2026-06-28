// ==========================================================================
// 🏰 CLOUDFLARE WORKER GATEWAY ENGINE - FULL INTEGRATED EDITION (2026)
// ==========================================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 🌐 XỬ LÝ CORS CHO COCOS CREATOR (BẮT BUỘC)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // 🔥 👉 CỔNG MẠNG 0: BẪY WEBSOCKET PHÒNG NÔNG TRẠI CHUNG (DURABLE OBJECT BINDING)
    if (url.pathname.startsWith("/farm-ws/")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket Upgrade", { status: 426 });
      }
      
      const worldId = url.pathname.split("/")[2] || "global_room_01";
      const doId = env.FARM_ROOM_DO.idFromName(worldId);
      const doStub = env.FARM_ROOM_DO.get(doId);

      return doStub.fetch(request);
    }

    const db = env.D1;

    // ==========================================
    // CỔNG 1: ĐĂNG NHẬP (LOGIN) - ĐÃ UPGRADE NÔNG TRẠI
    // ==========================================
    if ((url.pathname === "/login" || url.pathname === "/") && request.method === "POST") {
      try {
        const params = await request.json();
        const username = params.username;
        const password = params.password;

        if (!username || !password) {
          return errorResponse("Thiếu tài khoản hoặc mật khẩu!");
        }

        const user = await db.prepare("SELECT * FROM users WHERE username = ?").bind(username.toString().trim()).first();

        if (!user) {
          return errorResponse("Không tìm thấy tài khoản!");
        }

        if (user.password.toString().trim() !== password.toString().trim()) {
          return errorResponse("Sai mật khẩu!");
        }

        // Trả thêm 4 chỉ số Nông trại mới về cho Cocos Creator dựng sảnh
        return jsonResponse({
          success: true,
          message: "Đăng nhập thành công!",
          data: {
            username: user.username,
            coins: user.coins,
            gender: user.gender,
            captured: user.captured,
            energy: user.energy,
            avatar: user.avatar,
            total_coins: user.total_coins,
            // 🆕 Các trường bổ sung cho thế giới mở
            farm_energy: user.farm_energy !== null ? user.farm_energy : 100,
            upgrade_coins: user.upgrade_coins !== null ? user.upgrade_coins : 0,
            current_skin_id: user.current_skin_id || '',
            current_world_id: user.current_world_id || 'global_room_01'
          }
        });
      } catch (err) {
        return errorResponse("Lỗi hệ thống đăng nhập: " + err.message);
      }
    }

    // ==========================================
    // CỔNG 2: LƯU GAME REALTIME (SAVE) - ĐÃ UPGRADE NÔNG TRẠI SẠCH LỖI NULL
    // ==========================================
    if ((url.pathname === "/save" || url.pathname === "/") && request.method === "POST") {
      try {
        const params = await request.json();
        const username = params.username;
        const coins = params.coins;
        const gender = params.gender;
        const captured = params.captured;
        const energy = params.energy;

        if (!username) return errorResponse("Thiếu Username để lưu game!");

        const newCoins = parseInt(coins) || 0;
        
        // Đọc full thông số cũ lên làm giá trị dự phòng nếu gói tin cứu hộ từ BattleStage không gửi dữ liệu vườn
        const userObj = await db.prepare("SELECT coins, total_coins, farm_energy, upgrade_coins, current_skin_id, current_world_id FROM users WHERE username = ?").bind(username.toString().trim()).first();
        
        const oldCoins = userObj ? (parseInt(userObj.coins) || 0) : 0;
        const oldTotal = userObj ? (parseInt(userObj.total_coins) || 0) : 0;
        const calculatedTotal = oldTotal + (newCoins > oldCoins ? (newCoins - oldCoins) : 0);
        const finalEnergy = parseInt(energy) || 0;

        // Thuật toán gài mốc dự phòng bảo hiểm RAM 100% chống đè dữ liệu rỗng
        const finalFarmEnergy = params.farm_energy !== undefined ? parseInt(params.farm_energy) : (userObj ? userObj.farm_energy : 100);
        const finalUpgradeCoins = params.upgrade_coins !== undefined ? parseInt(params.upgrade_coins) : (userObj ? userObj.upgrade_coins : 0);
        const finalSkinId = params.current_skin_id !== undefined ? params.current_skin_id : (userObj ? userObj.current_skin_id : '');
        const finalWorldId = params.current_world_id !== undefined ? params.current_world_id : (userObj ? userObj.current_world_id : 'global_room_01');

        await db.prepare(`
          UPDATE users SET 
            coins = ?, 
            gender = ?, 
            captured = ?, 
            energy = ?, 
            total_coins = ?,
            last_save_time = ?,
            farm_energy = ?,
            upgrade_coins = ?,
            current_skin_id = ?,
            current_world_id = ?
          WHERE username = ?
        `).bind(
          newCoins,
          gender || '',
          captured || '{}',
          finalEnergy,
          calculatedTotal,
          Date.now(),
          finalFarmEnergy,
          finalUpgradeCoins,
          finalSkinId,
          finalWorldId,
          username.toString().trim()
        ).run();

        ctx.waitUntil((async () => {
          const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzkXP46IjCrgdRjFq9hH1mQ8YHljlsUJWwk63wYIDjkaZ5S0Ua9Juox9CokgFt0MKs/exec";
          try {
            let sheetGender = gender ? gender.toString().toUpperCase().trim() : "";
            if (sheetGender === "MALE") sheetGender = "M";
            if (sheetGender === "FEMALE") sheetGender = "F";

            await fetch(APPS_SCRIPT_URL, {
              method: "POST",
              headers: { "Content-Type": "text/plain;charset=utf-8" },
              body: JSON.stringify({
                action: "save",
                username: username.toString().trim(),
                coins: calculatedTotal,
                gender: sheetGender,
                captured: captured || '{}',
                energy: finalEnergy
              })
            });
          } catch (sheetErr) {
            console.error("[Chạy ngầm] Lỗi tự động đồng bộ dữ liệu về Sheet:", sheetErr);
          }
        })());

        return jsonResponse({ success: true, message: "Đã lưu vào D1 thành công rực rỡ! (Đang chạy ngầm đồng bộ full thông số về Sheet)" });
      } catch (err) {
        return errorResponse("Lỗi lưu game: " + err.message);
      }
    }

    // ==========================================
    // CỔNG 3: ĐỒNG BỘ TỪ SHEET MỚI (SYNC-SHEET)
    // ==========================================
    if (url.pathname === "/sync-sheet") {
      const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vT-EFZn4iPTyVHW35NtYDWCwVH5mt6Vuw9kbAFNMm8CkLXzu31QdoK7vW18NdlKLXKKgZIH9YYFKqoh/pub?gid=1029675025&single=true&output=csv"; 
      
      try {
        const response = await fetch(SHEET_CSV_URL);
        const csvText = await response.text();
        const lines = csvText.split(/\r?\n/).filter(line => line.trim() !== "");

        if (lines.length <= 1) {
          return errorResponse("Sheet trống hoặc sai định dạng!");
        }

        let count = 0;

        for (let i = 1; i < lines.length; i++) {
          const matches = lines[i].match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || [];
          const values = matches.map(v => v.trim().replace(/^"|"$/g, "").replace(/""/g, '"'));
          
          if (values.length < 2) continue;
          
          const username = values[0];
          const password = values[1];
          const coins = parseInt(values[2]) || 0;
          const gender = values[3] || '';
          
          let captured = values[4] || '{}';
          if (captured.startsWith('{') && !captured.endsWith('}')) captured = captured + '}';
          captured = captured.replace(/""/g, '"');
          
          const energy = parseInt(values[5]) || 0;
          const avatar = values[6] || '';
          const total_coins = parseInt(values[7]) || coins;

          if (!username) continue;

          await db.prepare(`
            INSERT INTO users (username, password, coins, gender, captured, energy, avatar, total_coins)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
              password = excluded.password, 
              coins = excluded.coins, 
              gender = excluded.gender,
              captured = excluded.captured, 
              energy = excluded.energy, 
              avatar = excluded.avatar, 
              total_coins = excluded.total_coins
          `).bind(username, password, coins, gender, captured, energy, avatar, total_coins).run();
          
          count++;
        }
        
        return jsonResponse({ success: true, message: `Đồng bộ hoàn tất! Đã nạp thành công ${count} tài khoản từ Sheet mới vào D1.` });
      } catch (error) {
        return errorResponse("Lỗi cào dữ liệu từ Sheet mới: " + error.message);
      }
    }

    // ==========================================
    // CỔNG 4: XUẤT DỮ LIỆU TỪ D1 VỀ LẠI GOOGLE SHEET
    // ==========================================
    if (url.pathname === "/export-sheet") {
      const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzkXP46IjCrgdRjFq9hH1mQ8YHljlsUJWwk63wYIDjkaZ5S0Ua9Juox9CokgFt0MKs/exec";

      try {
        const { results } = await db.prepare("SELECT * FROM users").all();

        if (!results || results.length === 0) {
          return errorResponse("Database D1 đang trống rỗng, không có gì để xuất!");
        }

        let successCount = 0;

        for (const user of results) {
          try {
            let sheetGender = user.gender ? user.gender.toString().toUpperCase().trim() : "";
            if (sheetGender === "MALE") sheetGender = "M";
            if (sheetGender === "FEMALE") sheetGender = "F";

            await fetch(APPS_SCRIPT_URL, {
              method: "POST",
              headers: { "Content-Type": "text/plain;charset=utf-8" },
              body: JSON.stringify({
                action: "save",
                username: user.username,
                coins: user.total_coins,
                gender: sheetGender,
                captured: user.captured,
                energy: user.energy
              })
            });
            successCount++;
          } catch (singleErr) {
            console.error(`Lỗi dòng user ${user.username}:`, singleErr);
          }
        }

        return jsonResponse({ 
          success: true, 
          message: `Xuất dữ liệu hoàn tất! Đã cập nhật thành công ${successCount}/${results.length} tài khoản từ D1 đè ngược về Google Sheet.` 
        });

      } catch (error) {
        return errorResponse("Thất bại khi đẩy dữ liệu về Sheet: " + error.message);
      }
    }

    // ==========================================
    // 💬 CỔNG CHAT 1: GỬI TIN NHẮN (SEND-CHAT)
    // ==========================================
    if (url.pathname === "/send-chat" && request.method === "POST") {
      try {
        const params = await request.json();
        let roomId = params.room_id ? params.room_id.toString().trim() : "GLOBAL";
        const sender = params.sender ? params.sender.toString().trim() : "Unknown";
        const message = params.message ? params.message.toString().trim() : "";

        if (!message) return errorResponse("Nội dung tin nhắn trống rỗng!");

        if (roomId !== "GLOBAL" && roomId.includes("_")) {
          const parts = roomId.split("_").map(p => p.trim()).sort();
          roomId = parts[0] + "_" + parts[1];
        }

        await db.prepare(`
          INSERT INTO chat_messages (room_id, sender, message, timestamp)
          VALUES (?, ?, ?, ?)
        `).bind(roomId, sender, message, Date.now()).run();

        return jsonResponse({ success: true, message: "Tin nhắn gửi thành công!" });
      } catch (err) {
        return errorResponse("Lỗi hệ thống gửi tin: " + err.message);
      }
    }

    // ==========================================
    // 💬 CỔNG CHAT 2: TẢI TIN VÀ LEFT JOIN (GET-CHAT)
    // ==========================================
    if (url.pathname === "/get-chat" && request.method === "GET") {
      try {
        let roomId = url.searchParams.get("room_id") || "GLOBAL";
        roomId = roomId.toString().trim();
        
        if (roomId !== "GLOBAL" && roomId.includes("_")) {
          const parts = roomId.split("_").map(p => p.trim()).sort();
          roomId = parts[0] + "_" + parts[1];
        }

        const { results } = await db.prepare(`
          SELECT 
            c.sender, 
            c.message, 
            c.timestamp,
            u.avatar
          FROM chat_messages c
          LEFT JOIN users u ON c.sender = u.username
          WHERE c.room_id = ? 
          ORDER BY c.id DESC LIMIT 50
        `).bind(roomId).all();

        return jsonResponse({ success: true, data: results ? results.reverse() : [] });
      } catch (err) {
        return errorResponse("Lỗi hệ thống tải tin: " + err.message);
      }
    }

    // ==========================================
    // 💬 CỔNG CHAT 3: TÌM USER (SEARCH-USER)
    // ==========================================
    if (url.pathname === "/search-user" && request.method === "GET") {
      try {
        const targetUser = url.searchParams.get("username");
        if (!targetUser) return errorResponse("Thiếu tên tài khoản cần tìm!");

        const user = await db.prepare("SELECT username FROM users WHERE username = ?").bind(targetUser.toString().trim()).first();

        if (!user) {
          return jsonResponse({ success: false, message: "Không tìm thấy bạn học này!" });
        }
        return jsonResponse({ success: true, username: user.username });
      } catch (err) {
        return errorResponse("Lỗi hệ thống tìm bạn: " + err.message);
      }
    }

    // ==========================================
    // 💬 CỔNG CHAT 4: LẤY DANH SÁCH BẠN CHAT (/get-private-friends)
    // ==========================================
    if (url.pathname === "/get-private-friends" && request.method === "GET") {
      try {
        const myUser = url.searchParams.get("username");
        if (!myUser) return errorResponse("Thiếu Username để quét danh sách bạn!");

        const matchPattern = `%${myUser.toString().trim()}%`;
        const { results } = await db.prepare(`
          SELECT DISTINCT room_id FROM chat_messages 
          WHERE room_id LIKE ? AND room_id != 'GLOBAL'
        `).bind(matchPattern).all();

        const friendSet = new Set();
        if (results && results.length > 0) {
          results.forEach(row => {
            const room = row.room_id.toString();
            if (room.includes("_")) {
              const parts = room.split("_");
              parts.forEach(p => {
                const cleaned = p.trim();
                if (cleaned !== "" && cleaned !== myUser.toString().trim()) {
                  friendSet.add(cleaned);
                }
              });
            }
          });
        }

        return jsonResponse({ success: true, data: Array.from(friendSet) });
      } catch (err) {
        return errorResponse("Lỗi bóc tách danh sách bạn chat: " + err.message);
      }
    }

    // ==========================================
    // 🛠️ CỔNG ADMIN 1: LẤY TOÀN BỘ DỮ LIỆU USER
    // ==========================================
    if (url.pathname === "/admin/get-all-users" && request.method === "GET") {
      try {
        const { results } = await db.prepare("SELECT * FROM users ORDER BY username ASC").all();
        return jsonResponse({ success: true, data: results || [] });
      } catch (err) {
        return errorResponse("Lỗi lấy danh sách user: " + err.message);
      }
    }

    // ==========================================
    // 🛠️ CỔNG ADMIN 2: BƠM ĐỒ CHO USER (ADMIN/CHEAT)
    // ==========================================
    if (url.pathname === "/admin/cheat" && request.method === "POST") {
      try {
        const body = await request.json();
        const { username, mon_id, mon_qty, coin, energy } = body;

        const userQuery = await db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
        if (!userQuery) return errorResponse("User không tồn tại!");

        let newCoins      = (userQuery.coins       || 0) + (Number(coin)    || 0);
        let newTotalCoins = (userQuery.total_coins  || 0) + (Number(coin)    || 0);
        let newEnergy     = (userQuery.energy       || 0) + (Number(energy)  || 0);

        let capturedData = {};
        try { capturedData = JSON.parse(userQuery.captured || '{}'); } catch (e) {}

        if (mon_id && mon_qty) {
          let currentQty = capturedData[mon_id] || 0;
          capturedData[mon_id] = currentQty + Number(mon_qty);
        }

        await db.prepare(
          `UPDATE users SET coins = ?, total_coins = ?, energy = ?, captured = ? WHERE username = ?`
        ).bind(newCoins, newTotalCoins, newEnergy, JSON.stringify(capturedData), username).run();

        return jsonResponse({ success: true, message: `Đã bơm đồ thành công cho ${username}` });
      } catch (err) {
        return errorResponse("Lỗi hệ thống cheat: " + err.message);
      }
    }

    return new Response("Cổng API Mon English không hợp lệ", { status: 404 });
  },

  // ==========================================
  // ⚡ CRON TRIGGER: HỒI NĂNG LƯỢNG CHIẾN ĐẤU CŨ
  // ==========================================
  async scheduled(event, env, ctx) {
    const db = env.D1;
    ctx.waitUntil((async () => {
      try {
        await db.prepare("UPDATE users SET energy = energy + 1 WHERE energy < 40").run();
        console.log("[Hẹn giờ] Đã cộng 1 năng lượng thành công cho toàn bộ tài khoản học sinh.");
      } catch (err) {
        console.error("[Hẹn giờ] Thất bại khi hồi năng lượng cục bộ D1:", err);
      }
    })());
  }
};

// ==========================================================================
// 🧠 ĐẠI NÃO ĐIỀU PHỐI PHÒNG CHƠI TRÊN RAM: DURABLE OBJECT CLASS
// ==========================================================================
export class FarmRoomDurableObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    
    this.roomSessions = new Map(); 
    this.worldId = "";
    this.houseLevel = 1;
    this.sharedInventory = {};
  }

  async fetch(request) {
    const url = new URL(request.url);
    this.worldId = url.pathname.split("/")[2] || "global_room_01";

    if (Object.keys(this.sharedInventory).length === 0) {
      await this.loadWorldStateFromD1();
    }

    const pair = new WebSocketPair();
    const [clientSocket, serverSocket] = Object.values(pair);

    await this.handleSessionConnection(serverSocket);

    return new Response(null, { status: 101, webSocket: clientSocket });
  }

  async handleSessionConnection(socket) {
    this.state.acceptWebSocket(socket);
    this.roomSessions.set(socket, { uid: "", skin: "", x: 0 });
  }

  async webSocketMessage(socket, messageText) {
    try {
      const msg = JSON.parse(messageText);
      const session = this.roomSessions.get(socket);

      switch (msg.action) {
        case "join":
          session.uid = msg.uid;
          session.skin = msg.skin;
          session.x = 0; 

          this.broadcastData({
            action: "user_joined",
            uid: session.uid,
            skin: session.skin,
            x: session.x
          }, socket);

          socket.send(JSON.stringify({
            action: "sync_room_state",
            house_level: this.houseLevel,
            inventory: this.sharedInventory,
            active_players: Array.from(this.roomSessions.values()).filter(p => p.uid !== "")
          }));
          break;

        case "move":
          session.x = msg.x;
          this.broadcastData({
            action: "user_moved",
            uid: session.uid,
            x: msg.x,
            dirX: msg.dirX
          }, socket);
          break;

        case "add_item":
          let itemId = msg.item_id;
          this.sharedInventory[itemId] = (this.sharedInventory[itemId] || 0) + 1;

          await this.saveWorldStateToD1();

          this.broadcastData({
            action: "inventory_updated",
            inventory: this.sharedInventory
          });
          break;
      }
    } catch (e) { console.error("❌ Lỗi xử lý WebSocket:", e); }
  }

  async webSocketClose(socket, code, reason, wasClean) {
    const session = this.roomSessions.get(socket);
    if (session && session.uid) {
      this.broadcastData({ action: "user_left", uid: session.uid });
    }
    this.roomSessions.delete(socket);
  }

  async webSocketError(socket, error) {
    this.roomSessions.delete(socket);
  }

  broadcastData(dataObject, excludeSocket = null) {
    const payload = JSON.stringify(dataObject);
    for (const socket of this.roomSessions.keys()) {
      if (socket !== excludeSocket && socket.readyState === 1) { 
        socket.send(payload);
      }
    }
  }

  async loadWorldStateFromD1() {
    try {
      const row = await this.env.D1.prepare("SELECT house_level, shared_inventory FROM farm_worlds WHERE world_id = ?")
        .bind(this.worldId)
        .first();
      if (row) {
        this.houseLevel = row.house_level;
        this.sharedInventory = JSON.parse(row.shared_inventory || "{}");
      }
    } catch (e) { console.error("🚨 Lỗi load DB D1:", e); }
  }

  async saveWorldStateToD1() {
    try {
      await this.env.D1.prepare("UPDATE farm_worlds SET shared_inventory = ? WHERE world_id = ?")
        .bind(JSON.stringify(this.sharedInventory), this.worldId)
        .run();
    } catch (e) { console.error("🚨 Lỗi ghi DB D1:", e); }
  }
}

// ==========================================
// 🔩 CÁC HÀM PHỤ TRỢ (HELPER CORES)
// ==========================================
function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With"
    }
  });
}

function errorResponse(msg) {
  return jsonResponse({ success: false, message: msg });
}

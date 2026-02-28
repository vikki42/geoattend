import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import bcrypt from "bcryptjs";
import { Parser } from 'json2csv';

let db: Database.Database;
try {
  db = new Database("attendance.db");
  console.log("Database connected successfully");
} catch (err) {
  console.error("Failed to connect to database:", err);
  process.exit(1);
}

// Initialize database
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT CHECK(role IN ('ceo', 'hr', 'employee')) DEFAULT 'employee',
      base_salary REAL DEFAULT 0,
      esi_enabled INTEGER DEFAULT 0,
      pf_enabled INTEGER DEFAULT 0,
      joining_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT CHECK(type IN ('check-in', 'check-out')) NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      status TEXT CHECK(status IN ('on-time', 'late', 'regularized')) DEFAULT 'on-time',
      regularization_reason TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS penalties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      reason TEXT NOT NULL,
      date DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS live_locations (
      user_id INTEGER PRIMARY KEY,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS leaves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT CHECK(type IN ('sick', 'casual', 'earned', 'unpaid')) NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      reason TEXT,
      status TEXT CHECK(status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      author_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (author_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      status TEXT CHECK(status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      radius REAL DEFAULT 200,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      start_time TEXT NOT NULL, -- Format: HH:MM
      end_time TEXT NOT NULL,   -- Format: HH:MM
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Pre-populate shifts
    INSERT OR IGNORE INTO shifts (id, name, start_time, end_time) VALUES 
    (1, 'Morning Shift (9AM-7PM)', '09:00', '19:00'),
    (2, 'Day Shift (10AM-8PM)', '10:00', '20:00');

    INSERT OR IGNORE INTO settings (key, value) VALUES ('office_lat', '12.9716');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('office_lng', '77.5946');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('allowed_radius', '300');
  `);
  console.log("Database tables initialized");
  
  // Add shift_id to users table if it doesn't exist
  try {
    db.exec("ALTER TABLE users ADD COLUMN shift_id INTEGER REFERENCES shifts(id) DEFAULT 1");
    console.log("Added shift_id to users table");
  } catch (err) {
    // Column might already exist
  }
} catch (err) {
  console.error("Failed to initialize database tables:", err);
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Auth Routes
  app.post("/api/register", async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: "Missing fields" });
    }
    try {
      const userCount = (db.prepare("SELECT COUNT(*) as count FROM users").get() as any).count;
      const role = userCount === 0 ? 'ceo' : 'employee';
      
      const hashedPassword = await bcrypt.hash(password, 10);
      const stmt = db.prepare("INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)");
      const info = stmt.run(username, email, hashedPassword, role);
      res.json({ id: info.lastInsertRowid, status: "success", role });
    } catch (error: any) {
      if (error.message.includes("UNIQUE constraint failed")) {
        return res.status(400).json({ error: "Username or email already exists" });
      }
      res.status(500).json({ error: "Database error" });
    }
  });

  app.post("/api/login", async (req, res) => {
    const { identifier, password } = req.body; // identifier can be username or email
    if (!identifier || !password) {
      return res.status(400).json({ error: "Missing fields" });
    }
    try {
      const user = db.prepare("SELECT * FROM users WHERE username = ? OR email = ?").get(identifier, identifier) as any;
      if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      res.json({ id: user.id, username: user.username, email: user.email, role: user.role });
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  // HR & Admin Routes
  app.get("/api/employees", (req, res) => {
    try {
      const rows = db.prepare("SELECT id, username, email, role, base_salary, esi_enabled, pf_enabled, joining_date FROM users").all();
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.post("/api/employees", async (req, res) => {
    const { username, email, password, role, base_salary, esi_enabled, pf_enabled } = req.body;
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      const stmt = db.prepare(`
        INSERT INTO users (username, email, password, role, base_salary, esi_enabled, pf_enabled) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const info = stmt.run(username, email, hashedPassword, role || 'employee', base_salary || 0, esi_enabled ? 1 : 0, pf_enabled ? 1 : 0);
      res.json({ id: info.lastInsertRowid, status: "success" });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/payroll/:userId", (req, res) => {
    const { userId } = req.params;
    try {
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
      if (!user) return res.status(404).json({ error: "User not found" });

      const penalties = db.prepare("SELECT SUM(amount) as total FROM penalties WHERE user_id = ?").get(userId) as any;
      const penaltyTotal = penalties.total || 0;

      // Simple Payroll Logic
      const base = user.base_salary;
      const pf = user.pf_enabled ? base * 0.12 : 0;
      const esi = user.esi_enabled ? base * 0.0075 : 0;
      const net = base - pf - esi - penaltyTotal;

      res.json({
        base,
        pf,
        esi,
        penalties: penaltyTotal,
        net
      });
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.post("/api/regularize", (req, res) => {
    const { attendanceId, reason } = req.body;
    try {
      db.prepare("UPDATE attendance SET status = 'regularized', regularization_reason = ? WHERE id = ?").run(reason, attendanceId);
      res.json({ status: "success" });
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.get("/api/export/attendance", (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT u.username, a.type, a.status, a.timestamp, a.latitude, a.longitude 
        FROM attendance a 
        JOIN users u ON a.user_id = u.id
      `).all();
      
      const parser = new Parser();
      const csv = parser.parse(rows);
      
      res.header('Content-Type', 'text/csv');
      res.attachment('attendance_report.csv');
      res.send(csv);
    } catch (error) {
      res.status(500).json({ error: "Export failed" });
    }
  });

  app.put("/api/users/:id", async (req, res) => {
    const { id } = req.params;
    const { username, email, password, currentPassword } = req.body;

    try {
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as any;
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Verify current password if updating password or email/username
      if (!(await bcrypt.compare(currentPassword, user.password))) {
        return res.status(401).json({ error: "Invalid current password" });
      }

      let query = "UPDATE users SET username = ?, email = ?";
      const params = [username || user.username, email || user.email];

      if (password) {
        const hashedPassword = await bcrypt.hash(password, 10);
        query += ", password = ?";
        params.push(hashedPassword);
      }

      query += " WHERE id = ?";
      params.push(id);

      db.prepare(query).run(...params);
      
      const updatedUser = db.prepare("SELECT id, username, email FROM users WHERE id = ?").get(id) as any;
      res.json(updatedUser);
    } catch (error: any) {
      if (error.message.includes("UNIQUE constraint failed")) {
        return res.status(400).json({ error: "Username or email already exists" });
      }
      res.status(500).json({ error: "Database error" });
    }
  });

  // Settings Routes
  app.get("/api/settings", (req, res) => {
    try {
      const rows = db.prepare("SELECT * FROM settings").all() as { key: string; value: string }[];
      const settings = rows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {});
      res.json(settings);
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.post("/api/settings", (req, res) => {
    const role = req.headers['x-user-role'];
    if (role !== 'ceo') {
      return res.status(403).json({ error: "Access denied" });
    }
    const { office_lat, office_lng, allowed_radius } = req.body;
    try {
      const upsert = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
      const transaction = db.transaction((data) => {
        if (data.office_lat !== undefined) upsert.run("office_lat", data.office_lat.toString());
        if (data.office_lng !== undefined) upsert.run("office_lng", data.office_lng.toString());
        if (data.allowed_radius !== undefined) upsert.run("allowed_radius", data.allowed_radius.toString());
      });
      transaction({ office_lat, office_lng, allowed_radius });
      res.json({ status: "success" });
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  // Locations Routes
  app.get("/api/locations", (req, res) => {
    try {
      const locations = db.prepare("SELECT * FROM locations ORDER BY name ASC").all();
      res.json(locations);
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.post("/api/locations", (req, res) => {
    const role = req.headers['x-user-role'];
    if (role !== 'ceo' && role !== 'hr') return res.status(403).json({ error: "Access denied" });
    const { name, latitude, longitude, radius } = req.body;
    try {
      const result = db.prepare("INSERT INTO locations (name, latitude, longitude, radius) VALUES (?, ?, ?, ?)").run(name, latitude, longitude, radius);
      res.json({ id: result.lastInsertRowid, status: "success" });
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.delete("/api/locations/all", (req, res) => {
    const role = req.headers['x-user-role'];
    if (role !== 'ceo' && role !== 'hr') return res.status(403).json({ error: "Access denied" });
    try {
      db.prepare("DELETE FROM locations").run();
      res.json({ status: "success" });
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.delete("/api/locations/:id", (req, res) => {
    const role = req.headers['x-user-role'];
    if (role !== 'ceo' && role !== 'hr') return res.status(403).json({ error: "Access denied" });
    const { id } = req.params;
    try {
      db.prepare("DELETE FROM locations WHERE id = ?").run(id);
      res.json({ status: "success" });
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  // Shifts Routes
  app.get("/api/shifts", (req, res) => {
    try {
      const shifts = db.prepare("SELECT * FROM shifts ORDER BY start_time ASC").all();
      res.json(shifts);
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.post("/api/shifts", (req, res) => {
    const role = req.headers['x-user-role'];
    if (role !== 'ceo' && role !== 'hr') return res.status(403).json({ error: "Access denied" });
    const { name, start_time, end_time } = req.body;
    try {
      const result = db.prepare("INSERT INTO shifts (name, start_time, end_time) VALUES (?, ?, ?)").run(name, start_time, end_time);
      res.json({ id: result.lastInsertRowid, status: "success" });
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.post("/api/attendance", (req, res) => {
    const { userId, type, latitude, longitude } = req.body;
    
    if (!userId || !type || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {
      // Get user's shift
      const user = db.prepare("SELECT u.*, s.start_time FROM users u LEFT JOIN shifts s ON u.shift_id = s.id WHERE u.id = ?").get(userId) as any;
      
      let status = 'on-time';
      if (type === 'check-in') {
        const now = new Date();
        const hours = now.getHours();
        const minutes = now.getMinutes();
        
        // Default to 9:30 AM if no shift assigned
        let shiftStartHour = 9;
        let shiftStartMin = 30;
        
        if (user && user.start_time) {
          const [h, m] = user.start_time.split(':').map(Number);
          shiftStartHour = h;
          shiftStartMin = m + 30; // Allow 30 mins grace period
          if (shiftStartMin >= 60) {
            shiftStartHour += 1;
            shiftStartMin -= 60;
          }
        }

        if (hours > shiftStartHour || (hours === shiftStartHour && minutes > shiftStartMin)) {
          status = 'late';
        }
      }

      const stmt = db.prepare(
        "INSERT INTO attendance (user_id, type, latitude, longitude, status) VALUES (?, ?, ?, ?, ?)"
      );
      const info = stmt.run(userId, type, latitude, longitude, status);
      res.json({ id: info.lastInsertRowid, status: "success", attendanceStatus: status });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Database error" });
    }
  });

  app.get("/api/attendance", (req, res) => {
    const { userId } = req.query;
    try {
      let query = `
        SELECT a.*, u.username as user_name 
        FROM attendance a 
        JOIN users u ON a.user_id = u.id 
      `;
      const params = [];

      if (userId) {
        query += " WHERE a.user_id = ?";
        params.push(userId);
      }

      query += " ORDER BY a.timestamp DESC";

      const rows = db.prepare(query).all(...params);
      res.json(rows);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Database error" });
    }
  });

  app.get("/api/employees", (req, res) => {
    const role = req.headers['x-user-role'];
    if (role !== 'ceo' && role !== 'hr') {
      return res.status(403).json({ error: "Access denied" });
    }
    try {
      const employees = db.prepare(`
        SELECT u.id, u.username, u.email, u.role, u.base_salary, u.esi_enabled, u.pf_enabled, u.joining_date, u.shift_id, s.name as shift_name
        FROM users u
        LEFT JOIN shifts s ON u.shift_id = s.id
      `).all();
      res.json(employees);
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.post("/api/employees", async (req, res) => {
    const role = req.headers['x-user-role'];
    if (role !== 'ceo' && role !== 'hr') {
      return res.status(403).json({ error: "Access denied" });
    }
    const { username, email, password, role: newRole, base_salary, esi_enabled, pf_enabled, joining_date, shift_id } = req.body;
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      const stmt = db.prepare("INSERT INTO users (username, email, password, role, base_salary, esi_enabled, pf_enabled, joining_date, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      stmt.run(username, email, hashedPassword, newRole, base_salary, esi_enabled ? 1 : 0, pf_enabled ? 1 : 0, joining_date, shift_id || 1);
      res.json({ status: "success" });
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.delete("/api/employees/:id", (req, res) => {
    const role = req.headers['x-user-role'];
    if (role !== 'ceo' && role !== 'hr') {
      return res.status(403).json({ error: "Access denied" });
    }
    const { id } = req.params;
    try {
      const transaction = db.transaction(() => {
        db.prepare("DELETE FROM attendance WHERE user_id = ?").run(id);
        db.prepare("DELETE FROM penalties WHERE user_id = ?").run(id);
        db.prepare("DELETE FROM live_locations WHERE user_id = ?").run(id);
        db.prepare("DELETE FROM users WHERE id = ?").run(id);
      });
      transaction();
      res.json({ status: "success" });
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.get("/api/payroll/:userId", (req, res) => {
    const { userId } = req.params;
    try {
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
      if (!user) return res.status(404).json({ error: "User not found" });

      const penalties = db.prepare("SELECT SUM(amount) as total FROM penalties WHERE user_id = ?").get(userId) as any;
      const penaltyAmount = penalties.total || 0;

      const base = user.base_salary || 0;
      const pf = user.pf_enabled ? base * 0.12 : 0;
      const esi = user.esi_enabled ? base * 0.0175 : 0;
      const net = base - pf - esi - penaltyAmount;

      res.json({
        base,
        pf,
        esi,
        penalties: penaltyAmount,
        net
      });
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.post("/api/regularize", (req, res) => {
    const { attendanceId, reason } = req.body;
    try {
      db.prepare("UPDATE attendance SET status = 'regularized', regularization_reason = ? WHERE id = ?").run(reason, attendanceId);
      res.json({ status: "success" });
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.get("/api/export/attendance", (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT u.username, a.type, a.status, a.timestamp, a.latitude, a.longitude 
        FROM attendance a 
        JOIN users u ON a.user_id = u.id 
        ORDER BY a.timestamp DESC
      `).all();
      
      const csv = [
        ["Username", "Type", "Status", "Timestamp", "Latitude", "Longitude"].join(","),
        ...rows.map((r: any) => [
          r.username,
          r.type,
          r.status,
          r.timestamp,
          r.latitude,
          r.longitude
        ].join(","))
      ].join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=attendance.csv");
      res.send(csv);
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.post("/api/live-location", (req, res) => {
    const { userId, latitude, longitude } = req.body;
    if (!userId || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: "Missing fields" });
    }
    try {
      db.prepare(`
        INSERT INTO live_locations (user_id, latitude, longitude, last_updated) 
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET 
          latitude = excluded.latitude,
          longitude = excluded.longitude,
          last_updated = CURRENT_TIMESTAMP
      `).run(userId, latitude, longitude);
      res.json({ status: "success" });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Database error" });
    }
  });

  app.get("/api/live-locations", (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT l.*, u.username 
        FROM live_locations l
        JOIN users u ON l.user_id = u.id
        WHERE l.last_updated > datetime('now', '-5 minutes')
      `).all();
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  // Leave Routes
  app.get("/api/leaves", (req, res) => {
    const { userId } = req.query;
    try {
      let query = "SELECT l.*, u.username FROM leaves l JOIN users u ON l.user_id = u.id";
      const params = [];
      if (userId) {
        query += " WHERE l.user_id = ?";
        params.push(userId);
      }
      query += " ORDER BY l.created_at DESC";
      const rows = db.prepare(query).all(...params);
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.post("/api/leaves", (req, res) => {
    const { userId, type, start_date, end_date, reason } = req.body;
    try {
      db.prepare("INSERT INTO leaves (user_id, type, start_date, end_date, reason) VALUES (?, ?, ?, ?, ?)")
        .run(userId, type, start_date, end_date, reason);
      res.json({ status: "success" });
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.put("/api/leaves/:id", (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
      db.prepare("UPDATE leaves SET status = ? WHERE id = ?").run(status, id);
      res.json({ status: "success" });
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  // Announcement Routes
  app.get("/api/announcements", (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT a.*, u.username as author_name 
        FROM announcements a 
        JOIN users u ON a.author_id = u.id 
        ORDER BY a.created_at DESC
      `).all();
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.post("/api/announcements", (req, res) => {
    const { title, content, authorId } = req.body;
    try {
      db.prepare("INSERT INTO announcements (title, content, author_id) VALUES (?, ?, ?)")
        .run(title, content, authorId);
      res.json({ status: "success" });
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  // Expense Routes
  app.get("/api/expenses", (req, res) => {
    const { userId } = req.query;
    try {
      let query = "SELECT e.*, u.username FROM expenses e JOIN users u ON e.user_id = u.id";
      const params = [];
      if (userId) {
        query += " WHERE e.user_id = ?";
        params.push(userId);
      }
      query += " ORDER BY e.created_at DESC";
      const rows = db.prepare(query).all(...params);
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.post("/api/expenses", (req, res) => {
    const { userId, amount, category, description } = req.body;
    try {
      db.prepare("INSERT INTO expenses (user_id, amount, category, description) VALUES (?, ?, ?, ?)")
        .run(userId, amount, category, description);
      res.json({ status: "success" });
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  app.put("/api/expenses/:id", (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
      db.prepare("UPDATE expenses SET status = ? WHERE id = ?").run(status, id);
      res.json({ status: "success" });
    } catch (error) {
      res.status(500).json({ error: "Database error" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(process.cwd(), "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(process.cwd(), "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

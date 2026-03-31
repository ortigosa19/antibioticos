import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";

import { emailStatus, sendTestEmail, sendLowStockEmail, sendLowStockSummaryEmail } from "./mailer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------------- SQLite (LOCAL) ----------------
// Prioridad:
// 1) SQLITE_PATH si está definido
// 2) backend/db2.db si existe (viene con el proyecto y suele tener datos)
// 3) backend/db/local.db
const envPath = process.env.SQLITE_PATH && String(process.env.SQLITE_PATH).trim();
const candidate1 = envPath ? path.resolve(__dirname, envPath) : null;
const candidate2 = path.join(__dirname, "db2.db");
const candidate3 = path.join(__dirname, "db", "local.db");

const DB_PATH =
  (candidate1 && fs.existsSync(candidate1) && candidate1) ||
  (fs.existsSync(candidate2) && candidate2) ||
  candidate3;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ---------- BACKUP AUTOMÁTICO (LOCAL) ----------
// Crea una copia de seguridad de la base de datos al arrancar.
// Desactívalo poniendo LOCAL_DB_BACKUP=0 en el .env
try {
  const doBackup = String(process.env.LOCAL_DB_BACKUP ?? "1").trim() !== "0";
  if (doBackup && fs.existsSync(DB_PATH)) {
    const backupDir = path.join(__dirname, "backup");
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(backupDir, `local_${stamp}.db`);
    fs.copyFileSync(DB_PATH, backupPath);
    // Limpieza: deja como máximo 30 backups
    const files = fs.readdirSync(backupDir)
      .filter(f => /^local_.*\.db$/i.test(f))
      .map(f => ({ f, t: fs.statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a,b) => b.t - a.t);
    for (const old of files.slice(30)) {
      try { fs.unlinkSync(path.join(backupDir, old.f)); } catch {}
    }
    console.log("💾 Backup DB creado:", backupPath);
  }
} catch (e) {
  console.warn("⚠️ No se pudo crear backup de la DB:", String(e?.message || e));
}

const db = new Database(DB_PATH);

// --- init alert_emails table (primary TO + BCC forwards)
db.exec(`
  CREATE TABLE IF NOT EXISTS alert_emails (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    primary_to TEXT,
    forwards_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT
  );
  INSERT OR IGNORE INTO alert_emails (id, primary_to, forwards_json, updated_at)
  VALUES (1, NULL, '[]', datetime('now'));
`);


db.pragma("journal_mode = DELETE");
// En local priorizamos robustez ante cortes/apagados
try { db.pragma("synchronous = FULL"); } catch {}

// Helper: detecta SELECT
function isSelect(sql) {
  return /^\s*select\b/i.test(sql);
}

// Helper: convierte placeholders $1, $2... (Postgres) a ? (SQLite)
function toSqliteParams(sql) {
  return sql.replace(/\$\d+/g, "?");
}

// Wrapper estilo pg: devuelve { rows }
async function dbQuery(text, params = []) {
  const sql = toSqliteParams(String(text)).trim();
  const stmt = db.prepare(sql);

  if (isSelect(sql)) {
    return { rows: stmt.all(params) };
  }

  const info = stmt.run(params);
  return { rows: [], changes: info.changes, lastInsertRowid: info.lastInsertRowid };
}

// “client” compatible con tu código (BEGIN/COMMIT/ROLLBACK con query)
function getClient() {
  return {
    query: async (text, params = []) => dbQuery(text, params),
    release: () => {},
  };
}

async function initDb() {
  // Esquema mínimo compatible con el frontend
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS antibiogramas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT UNIQUE NOT NULL
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS antibioticos (
      codigo TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      cantidad INTEGER NOT NULL DEFAULT 0,
      stock_minimo INTEGER NOT NULL DEFAULT 0
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS antibiograma_antibiotico (
      antibiograma_id INTEGER NOT NULL,
      antibiotico_codigo TEXT NOT NULL,
      PRIMARY KEY (antibiograma_id, antibiotico_codigo),
      FOREIGN KEY (antibiograma_id) REFERENCES antibiogramas(id) ON DELETE CASCADE,
      FOREIGN KEY (antibiotico_codigo) REFERENCES antibioticos(codigo) ON DELETE CASCADE
    );
  `);

  await dbQuery(`
    CREATE TABLE IF NOT EXISTS salidas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      antibiograma_id INTEGER NOT NULL,
      unidades INTEGER NOT NULL,
      FOREIGN KEY (antibiograma_id) REFERENCES antibiogramas(id) ON DELETE CASCADE
    );
  `);

  // Limpieza defensiva: elimina filas "cabecera" o valores no numéricos
  // (p. ej. cuando se importa un CSV/Excel y se cuela la primera fila).
  await dbQuery(`
    DELETE FROM antibioticos
    WHERE codigo IN ('codigo','Código','CODIGO','COD')
       OR nombre IN ('nombre','NOMBRE')
       OR typeof(cantidad) != 'integer'
       OR typeof(stock_minimo) != 'integer'
  `);
}

// --------- API ---------
app.get("/api/health", (req, res) => res.json({ ok: true, db: "sqlite", db_path: DB_PATH }));

app.get("/api/dbcheck", async (req, res) => {
  try {
    const r = await dbQuery("SELECT 1 as ok");
    res.json({ ok: true, db: r.rows?.[0]?.ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});


// --------- Alert Emails (TO + BCC forwards) ---------
function normalizeEmail(s) {
  return String(s || "").trim().toLowerCase();
}
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function getAlertEmailsRow() {
  const row = db.prepare("SELECT primary_to, forwards_json FROM alert_emails WHERE id=1").get();
  if (!row) return { primary_to: null, forwards: [] };
  let forwards = [];
  try { forwards = JSON.parse(row.forwards_json || "[]"); } catch {}
  if (!Array.isArray(forwards)) forwards = [];
  return { primary_to: row.primary_to || null, forwards };
}
function saveAlertEmailsRow({ primary_to, forwards }) {
  db.prepare(`
    UPDATE alert_emails
    SET primary_to = ?, forwards_json = ?, updated_at = datetime('now')
    WHERE id=1
  `).run(primary_to || null, JSON.stringify(forwards || []));
}

// DEVUELVE destinatarios efectivos para el envío: DB tiene prioridad, si no usa EMAIL_TO
function getRecipientsEffective() {
  const row = getAlertEmailsRow();
  const fallbackTo = (process.env.EMAIL_TO || process.env.EMAIL_DESTINO || "").trim() || null;
  const to = row.primary_to || fallbackTo;
  const bcc = (row.forwards || []).filter(Boolean);
  return { to, bcc };
}

// API: leer configuración
app.get("/api/alert-emails", (req, res) => {
  try {
    const row = getAlertEmailsRow();
    const from = (process.env.EMAIL_USER || "").trim() || null;
    res.json({ ok: true, from, primary_to: row.primary_to, forwards: row.forwards });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// API: guardar destinatario principal (admin)
// API: guardar destinatario principal \(LOCAL: sin admin\)
app.put("/api/alert-emails/primary", (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (email && !isValidEmail(email)) return res.status(400).json({ ok:false, error:"Email no válido" });

    const row = getAlertEmailsRow();
    row.primary_to = email || null;
    saveAlertEmailsRow(row);
    res.json({ ok:true, primary_to: row.primary_to, forwards: row.forwards });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});


// API: añadir BCC (admin)
// API: añadir BCC (LOCAL: sin admin)
app.post("/api/alert-emails/forwards", (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email || !isValidEmail(email)) return res.status(400).json({ ok:false, error:"Email no válido" });

    const row = getAlertEmailsRow();
    if (!row.forwards.includes(email)) row.forwards.push(email);
    saveAlertEmailsRow(row);
    res.json({ ok:true, forwards: row.forwards });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});


// API: quitar BCC (admin)
// API: quitar BCC (LOCAL: sin admin)
app.delete("/api/alert-emails/forwards", (req, res) => {
  try {
    const email = normalizeEmail(req.query?.email);
    const row = getAlertEmailsRow();
    row.forwards = row.forwards.filter(e => e !== email);
    saveAlertEmailsRow(row);
    res.json({ ok:true, forwards: row.forwards });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});


// --------- Email (LOCAL) ---------
app.get("/api/email/status", (req, res) => {
  const r = emailStatus();
  const rec = getRecipientsEffective();
  res.json({ ...r, effective_to: rec.to ? "OK" : "MISSING", bcc_count: (rec.bcc||[]).length });
});
// POST /api/email/test { subject? }
app.post("/api/email/test", async (req, res) => {
  try {
    const subject = String(req.body?.subject || "PRUEBA CORREO LOCAL");
    const r = await sendTestEmail(subject, getRecipientsEffective());
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/antibiogramas", async (req, res) => {
  try {
    const r = await dbQuery("SELECT id, nombre FROM antibiogramas ORDER BY nombre");
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Crear un antibiograma (modo local)
// Body: { nombre: "ATB PSEUDOMONAS" }
app.post("/api/antibiogramas", async (req, res) => {
  try {
    const nombre = String(req.body?.nombre || "").trim();
    if (!nombre) return res.status(400).json({ error: "nombre requerido" });

    // Inserta si no existe
    await dbQuery("INSERT OR IGNORE INTO antibiogramas (nombre) VALUES ($1)", [nombre]);

    // Devuelve el id (tanto si era nuevo como si ya existía)
    const r = await dbQuery("SELECT id, nombre FROM antibiogramas WHERE nombre=$1", [nombre]);
    const row = r.rows?.[0];
    if (!row) return res.status(500).json({ error: "no se pudo crear/leer el antibiograma" });

    res.json({ ok: true, id: row.id, nombre: row.nombre });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/antibioticos", async (req, res) => {
  try {
    const r = await dbQuery(
      `
      SELECT
        codigo,
        nombre,
        CAST(cantidad AS INTEGER) AS cantidad,
        CAST(stock_minimo AS INTEGER) AS stock_minimo
      FROM antibioticos
      WHERE codigo NOT IN ('codigo','Código','CODIGO','COD')
      ORDER BY nombre
      `
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Alertas: stock bajo (cantidad <= stock_minimo)
app.get("/api/alerts/low-stock", async (req, res) => {
  try {
    const r = await dbQuery(
      `
      SELECT codigo, nombre, cantidad, stock_minimo
      FROM antibioticos
      WHERE cantidad <= stock_minimo
      ORDER BY (cantidad - stock_minimo) ASC, nombre ASC
      `
    );
    res.json({ ok: true, count: r.rows.length, items: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: "low-stock query failed", details: String(e?.message || e) });
  }
});

app.get("/api/antibiogramas/:id/antibioticos", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
    const r = await dbQuery(
      "SELECT antibiotico_codigo AS codigo FROM antibiograma_antibiotico WHERE antibiograma_id=$1 ORDER BY antibiotico_codigo",
      [id]
    );
    res.json(r.rows.map((x) => x.codigo));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/antibiogramas/:id/antibioticos_detalle", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
    const r = await dbQuery(
      `
      SELECT a.codigo, a.nombre, a.cantidad, a.stock_minimo
      FROM antibiograma_antibiotico aa
      JOIN antibioticos a ON a.codigo = aa.antibiotico_codigo
      WHERE aa.antibiograma_id = $1
      ORDER BY a.nombre;
      `,
      [id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/antibiogramas/:id/antibioticos", async (req, res) => {
  const client = getClient();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
    const codes = Array.isArray(req.body?.codes) ? req.body.codes : [];

    await client.query("BEGIN");
    await client.query("DELETE FROM antibiograma_antibiotico WHERE antibiograma_id=$1", [id]);

    for (const c of codes) {
      if (!c) continue;
      await client.query(
        "INSERT OR IGNORE INTO antibiograma_antibiotico (antibiograma_id, antibiotico_codigo) VALUES ($1,$2)",
        [id, String(c)]
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true, count: codes.length });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    client.release();
  }
});

app.put("/api/antibiogramas/:id/antibioticos", async (req, res) => {
  const client = getClient();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "id inválido" });
    const codes = Array.isArray(req.body?.codes) ? req.body.codes : [];

    await client.query("BEGIN");
    await client.query("DELETE FROM antibiograma_antibiotico WHERE antibiograma_id=$1", [id]);

    for (const c of codes) {
      if (!c) continue;
      await client.query(
        "INSERT OR IGNORE INTO antibiograma_antibiotico (antibiograma_id, antibiotico_codigo) VALUES ($1,$2)",
        [id, String(c)]
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true, count: codes.length });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    client.release();
  }
});

app.put("/api/antibioticos/:codigo", async (req, res) => {
  try {
    const codigo = String(req.params.codigo);
    const cantidad = req.body?.cantidad;
    const stock_minimo = req.body?.stock_minimo;

    if (!Number.isInteger(cantidad) || cantidad < 0) {
      return res.status(400).json({ error: "cantidad debe ser entero >= 0" });
    }
    if (!Number.isInteger(stock_minimo) || stock_minimo < 0) {
      return res.status(400).json({ error: "stock_minimo debe ser entero >= 0" });
    }

    await dbQuery(
      `UPDATE antibioticos
       SET cantidad=$1, stock_minimo=$2
       WHERE codigo=$3`,
      [cantidad, stock_minimo, codigo]
    );

    const r2 = await dbQuery(
      "SELECT codigo, nombre, cantidad, stock_minimo FROM antibioticos WHERE codigo=$1",
      [codigo]
    );

    if (!r2.rows.length) return res.status(404).json({ error: "Antibiótico no encontrado" });

    const item = r2.rows[0];

    // ✅ SIEMPRE avisar si queda en/bajo el mínimo (también al editar cantidad/minimo)
    try {
      if (Number(item.cantidad) <= Number(item.stock_minimo)) {
        await sendLowStockEmail(item, getRecipientsEffective());
      }
    } catch (mailErr) {
      console.warn("⚠️ No se pudo enviar correo de stock bajo (PUT antibioticos):", String(mailErr?.message || mailErr));
    }

    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/antibioticos/:codigo/restar", async (req, res) => {
  const client = getClient();
  try {
    const codigo = String(req.params.codigo);
    const n = Number(req.body?.cantidad);
    if (!Number.isInteger(n) || n <= 0) return res.status(400).json({ error: "cantidad inválida" });

    await client.query("BEGIN");

    const cur = await client.query(
      "SELECT codigo, nombre, cantidad, stock_minimo FROM antibioticos WHERE codigo=$1",
      [codigo]
    );
    if (!cur.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Antibiótico no encontrado" });
    }

    const row = cur.rows[0];
    if (Number(row.cantidad) < n) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `Stock insuficiente. Hay ${row.cantidad} y quieres restar ${n}.` });
    }

    await client.query(
      "UPDATE antibioticos SET cantidad = cantidad - $1 WHERE codigo=$2",
      [n, codigo]
    );

    const upd = await client.query(
      "SELECT codigo, nombre, cantidad, stock_minimo FROM antibioticos WHERE codigo=$1",
      [codigo]
    );

    await client.query("COMMIT");

    const item = upd.rows[0];

    // Enviar correo si queda en/bajo el mínimo (no bloquea la operación).
    try {
      if (Number(item.cantidad) <= Number(item.stock_minimo)) {
        await sendLowStockEmail(item, getRecipientsEffective());
      }
    } catch (mailErr) {
      console.warn("⚠️ No se pudo enviar correo de stock bajo:", String(mailErr?.message || mailErr));
    }

    res.json({ ok: true, item });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    client.release();
  }
});

app.post("/api/salidas", async (req, res) => {
  const client = getClient();
  try {
    const antibiograma_id = Number(req.body?.antibiograma_id);
    const unidades = Number(req.body?.unidades);
    if (!Number.isInteger(antibiograma_id) || antibiograma_id <= 0) {
      return res.status(400).json({ error: "antibiograma_id inválido" });
    }
    if (!Number.isInteger(unidades) || unidades <= 0) {
      return res.status(400).json({ error: "unidades inválidas" });
    }

    await client.query("BEGIN");

    const items = await client.query(
      `
      SELECT a.codigo, a.nombre, a.cantidad, a.stock_minimo
      FROM antibiograma_antibiotico aa
      JOIN antibioticos a ON a.codigo = aa.antibiotico_codigo
      WHERE aa.antibiograma_id = $1
      `,
      [antibiograma_id]
    );

    if (!items.rows.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Ese antibiograma no tiene antibióticos asignados" });
    }

    const insuf = items.rows
      .map((r) => ({ ...r, quedaria: Number(r.cantidad) - unidades }))
      .filter((r) => r.quedaria < 0);

    if (insuf.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Stock insuficiente para registrar la salida.",
        insuficientes: insuf.map((r) => ({ codigo: r.codigo, nombre: r.nombre, cantidad: r.cantidad, pedir: unidades })),
      });
    }

    const touched = [];
    for (const r of items.rows) {
      await client.query(
        "UPDATE antibioticos SET cantidad = cantidad - $1 WHERE codigo=$2",
        [unidades, r.codigo]
      );
      touched.push(String(r.codigo));
    }

    await client.query("INSERT INTO salidas (antibiograma_id, unidades) VALUES ($1,$2)", [antibiograma_id, unidades]);

    await client.query("COMMIT");

    // Correo resumen: solo una vez por salida (si alguno queda bajo mínimos)
    try {
      if (touched.length) {
        const q = await dbQuery(
          `
          SELECT codigo, nombre, cantidad, stock_minimo
          FROM antibioticos
          WHERE codigo IN (${touched.map(() => "?").join(",")})
            AND cantidad <= stock_minimo
          ORDER BY nombre
          `,
          touched
        );
        if (q.rows.length) {
          await sendLowStockSummaryEmail({
            motivo: `Salida antibiograma #${antibiograma_id} (-${unidades})`,
            items: q.rows,
          });
        }
      }
    } catch (mailErr) {
      console.warn("⚠️ No se pudo enviar correo resumen de stock bajo:", String(mailErr?.message || mailErr));
    }

    res.json({ ok: true });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    client.release();
  }
});

// --------- Frontend (estático) ---------
const frontendDir = path.join(__dirname, "..", "frontend");
app.use(express.static(frontendDir));

// Root -> login
app.get("/", (req, res) => res.sendFile(path.join(frontendDir, "index.html")));

// Fallback simple: si piden /algo y existe en frontend, lo sirve.
app.get("/:file", (req, res, next) => {
  const f = path.join(frontendDir, req.params.file);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) return res.sendFile(f);
  next();
});

const PORT = process.env.PORT || 8080;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log("✅ API + Frontend en puerto", PORT);
      console.log("✅ SQLite DB:", DB_PATH);
    });
  })
  .catch((e) => {
    console.error("❌ Error init DB:", e);
    process.exit(1);
  });


// ===== RESTAR MULTIPLE (AUTO AÑADIDO) =====
app.post("/api/restar-multiple", async (req,res)=>{
  try{
    const items=req.body?.items;
    if(!Array.isArray(items)||!items.length) return res.status(400).json({error:"items requerido"});
    await db.run("BEGIN");
    for(const it of items){
      const row=await db.get("SELECT cantidad FROM antibioticos WHERE codigo=?",[it.codigo]);
      if(!row||row.cantidad<it.cantidad){
        await db.run("ROLLBACK");
        return res.status(409).json({error:"stock insuficiente",codigo:it.codigo});
      }
      await db.run("UPDATE antibioticos SET cantidad=cantidad-? WHERE codigo=?",[it.cantidad,it.codigo]);
    }
    await db.run("COMMIT");
    res.json({ok:true});
  }catch(e){
    try{await db.run("ROLLBACK");}catch{}
    res.status(500).json({error:String(e)});
  }
});

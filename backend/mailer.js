import nodemailer from "nodemailer";

// Variables esperadas en backend/.env
// EMAIL_USER=... (tu Gmail)
// EMAIL_PASS=... (contraseña de aplicación)
// EMAIL_TO=...   (destinatario)

const EMAIL_USER = (process.env.EMAIL_USER || "").trim();
const EMAIL_PASS = (process.env.EMAIL_PASS || "").trim();
const EMAIL_TO = (process.env.EMAIL_TO || process.env.EMAIL_DESTINO || "").trim();

// Anti-spam simple: no repetir alertas del mismo antibiótico en menos de X minutos.
const MINUTES_BETWEEN_SAME_ALERT = Number(process.env.EMAIL_THROTTLE_MINUTES || 20);
const lastSent = new Map(); // key -> timestamp

function canSend(key) {
  const now = Date.now();
  const prev = lastSent.get(key) || 0;
  if (now - prev < MINUTES_BETWEEN_SAME_ALERT * 60 * 1000) return false;
  lastSent.set(key, now);
  return true;
}

function resolveRecipients(overrides) {
  const to = (overrides?.to || "").trim() || EMAIL_TO;
  let bcc = overrides?.bcc;
  if (typeof bcc === "string") bcc = bcc.split(",").map(s=>s.trim()).filter(Boolean);
  if (!Array.isArray(bcc)) bcc = [];
  return { to, bcc };
}

function isConfigured(overrides) {

  const r = resolveRecipients(overrides);
  return Boolean(EMAIL_USER && EMAIL_PASS && r.to);
}

export function emailStatus() {
  return {
    configured: isConfigured(),
    email_user: EMAIL_USER ? "OK" : "MISSING",
    email_to: EMAIL_TO ? "OK" : "MISSING",
    throttle_minutes: MINUTES_BETWEEN_SAME_ALERT,
  };
}

function getTransporter() {
  // Gmail (recomendado en local)
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });
}

export async function sendTestEmail(subject = "PRUEBA CORREO LOCAL", recipients = null) {
  if (!isConfigured(recipients)) {
    console.warn("⚠️ Email no configurado. Define EMAIL_USER, EMAIL_PASS y EMAIL_TO en backend/.env");
    return { ok: false, skipped: true, reason: "not_configured" };
  }

  const transporter = getTransporter();
  const info = await transporter.sendMail({
    from: EMAIL_USER,
    to: resolveRecipients(recipients).to,
    bcc: resolveRecipients(recipients).bcc.length ? resolveRecipients(recipients).bcc : undefined,
    subject,
    text: "Correo de prueba desde la API",
  });

  return { ok: true, messageId: info?.messageId };
}

export async function sendLowStockEmail(item, recipients = null) {
  if (!isConfigured(recipients)) {
    console.warn("⚠️ Email no configurado. Define EMAIL_USER, EMAIL_PASS y EMAIL_TO en backend/.env");
    return { ok: false, skipped: true, reason: "not_configured" };
  }

  const codigo = String(item.codigo || "");
  if (!codigo) return { ok: false, skipped: true, reason: "missing_codigo" };
  if (!canSend(`single:${codigo}`)) return { ok: true, skipped: true, reason: "throttled" };

  const nombre = String(item.nombre || "(sin nombre)");
  const cantidad = Number(item.cantidad);
  const stockMin = Number(item.stock_minimo);

  const transporter = getTransporter();
  await transporter.sendMail({
    from: EMAIL_USER,
    to: resolveRecipients(recipients).to,
    bcc: resolveRecipients(recipients).bcc.length ? resolveRecipients(recipients).bcc : undefined,
    subject: `⚠️ STOCK BAJO: ${nombre} (${codigo})`,
    html: `
      <h2>⚠️ Alerta de stock bajo</h2>
      <p><b>${nombre}</b> (${codigo})</p>
      <p>Stock actual: <b>${Number.isFinite(cantidad) ? cantidad : item.cantidad}</b></p>
      <p>Stock mínimo: <b>${Number.isFinite(stockMin) ? stockMin : item.stock_minimo}</b></p>
      <hr/>
      <p style="color:#666">Meteo/Hospital · alerta automática</p>
    `,
  });

  return { ok: true };
}

export async function sendLowStockSummaryEmail({ motivo, items }, recipients = null) {
  if (!isConfigured(recipients)) {
    console.warn("⚠️ Email no configurado. Define EMAIL_USER, EMAIL_PASS y EMAIL_TO en backend/.env");
    return { ok: false, skipped: true, reason: "not_configured" };
  }
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { ok: true, skipped: true, reason: "empty" };
  if (!canSend(`summary:${motivo || "salida"}`)) return { ok: true, skipped: true, reason: "throttled" };

  const rows = list
    .map((i) => {
      const c = String(i.codigo || "");
      const n = String(i.nombre || "");
      const q = Number(i.cantidad);
      const m = Number(i.stock_minimo);
      return `<tr><td>${c}</td><td>${n}</td><td style="text-align:right">${Number.isFinite(q) ? q : i.cantidad}</td><td style="text-align:right">${Number.isFinite(m) ? m : i.stock_minimo}</td></tr>`;
    })
    .join("");

  const transporter = getTransporter();
  await transporter.sendMail({
    from: EMAIL_USER,
    to: resolveRecipients(recipients).to,
    bcc: resolveRecipients(recipients).bcc.length ? resolveRecipients(recipients).bcc : undefined,
    subject: `⚠️ STOCK BAJO (resumen)`,
    html: `
      <h2>⚠️ Resumen de stock bajo</h2>
      <p><b>Motivo:</b> ${motivo || "Salida"}</p>
      <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
        <thead><tr><th>Código</th><th>Antibiótico</th><th>Stock</th><th>Mínimo</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <hr/>
      <p style="color:#666">Meteo/Hospital · alerta automática</p>
    `,
  });

  return { ok: true };
}

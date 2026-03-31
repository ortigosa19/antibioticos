// Envío de alertas de stock bajo por email (solo si está configurado).
// Diseñado para funcionar en local (Windows) y también en despliegues.
//
// Variables .env:
//   EMAIL_USER=tu_gmail@gmail.com
//   EMAIL_PASS=contraseña_de_aplicación_gmail
//   EMAIL_TO=destino@correo.com (si no, usa EMAIL_USER)
//   EMAIL_FROM=opcional (si no, usa EMAIL_USER)
//   LOW_STOCK_THROTTLE_MIN=30 (opcional) -> evita enviar el mismo aviso continuamente

const throttleMinutes = Number(process.env.LOW_STOCK_THROTTLE_MIN || 30);
const throttleMs = Number.isFinite(throttleMinutes) ? throttleMinutes * 60 * 1000 : 30 * 60 * 1000;

// Memoria en RAM para no repetir correos constantemente.
// key: codigo, value: timestamp último envío
const lastSent = new Map();

function isConfigured() {
  const u = String(process.env.EMAIL_USER || "").trim();
  const p = String(process.env.EMAIL_PASS || "").trim();
  return Boolean(u && p);
}

async function getTransporter() {
  // Import dinámico para no romper si el usuario aún no hizo `npm i nodemailer`.
  const mod = await import("nodemailer");
  const nodemailer = mod.default || mod;

  const user = String(process.env.EMAIL_USER).trim();
  const pass = String(process.env.EMAIL_PASS).trim();

  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
}

function shouldThrottle(key) {
  const now = Date.now();
  const prev = lastSent.get(key) || 0;
  if (now - prev < throttleMs) return true;
  lastSent.set(key, now);
  return false;
}

function mailMeta() {
  const user = String(process.env.EMAIL_USER || "").trim();
  const from = String(process.env.EMAIL_FROM || user).trim();
  const to = String(process.env.EMAIL_TO || user).trim();
  return { user, from, to };
}

function renderItemRow(i) {
  const codigo = String(i.codigo ?? "");
  const nombre = String(i.nombre ?? "");
  const cantidad = Number(i.cantidad ?? 0);
  const stock_minimo = Number(i.stock_minimo ?? 0);
  const delta = cantidad - stock_minimo;
  return `
    <tr>
      <td style="padding:6px 10px;border:1px solid #ddd;">${codigo}</td>
      <td style="padding:6px 10px;border:1px solid #ddd;">${nombre}</td>
      <td style="padding:6px 10px;border:1px solid #ddd;text-align:right;">${cantidad}</td>
      <td style="padding:6px 10px;border:1px solid #ddd;text-align:right;">${stock_minimo}</td>
      <td style="padding:6px 10px;border:1px solid #ddd;text-align:right;">${delta}</td>
    </tr>
  `;
}

async function sendEmail({ subject, html }) {
  if (!isConfigured()) return { ok: false, skipped: true, reason: "EMAIL_USER/EMAIL_PASS no configurados" };

  const { from, to } = mailMeta();
  const transporter = await getTransporter();
  await transporter.sendMail({ from, to, subject, html });
  return { ok: true };
}

export async function sendLowStockAlertIfNeeded(item) {
  try {
    if (!item) return { ok: false, skipped: true, reason: "sin item" };
    const cantidad = Number(item.cantidad ?? 0);
    const stock_minimo = Number(item.stock_minimo ?? 0);
    if (!(cantidad <= stock_minimo)) return { ok: false, skipped: true, reason: "no está en stock bajo" };

    const key = `single:${String(item.codigo ?? item.nombre ?? "?")}`;
    if (shouldThrottle(key)) return { ok: false, skipped: true, reason: "throttle" };

    const subject = `⚠️ STOCK BAJO: ${String(item.nombre || item.codigo || "Antibiótico")}`;
    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.45">
        <h2 style="margin:0 0 10px">⚠️ Alerta de stock bajo</h2>
        <p style="margin:0 0 12px"><b>${String(item.nombre || "")}</b> (${String(item.codigo || "")})</p>
        <table style="border-collapse:collapse;margin-top:6px">
          <thead>
            <tr>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Código</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Nombre</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:right">Stock</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:right">Mínimo</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:right">Diferencia</th>
            </tr>
          </thead>
          <tbody>
            ${renderItemRow(item)}
          </tbody>
        </table>
        <p style="margin-top:14px;color:#666">(Enviado automáticamente por tu sistema local)</p>
      </div>
    `;

    return await sendEmail({ subject, html });
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function sendLowStockBatchAlertIfNeeded(items, context = "") {
  try {
    const list = Array.isArray(items) ? items : [];
    const low = list.filter((i) => Number(i.cantidad ?? 0) <= Number(i.stock_minimo ?? 0));
    if (!low.length) return { ok: false, skipped: true, reason: "no hay stock bajo" };

    const key = `batch:${low.map((x) => String(x.codigo || x.nombre)).join(",")}`;
    if (shouldThrottle(key)) return { ok: false, skipped: true, reason: "throttle" };

    const subject = `⚠️ STOCK BAJO (${low.length}) ${context ? "- " + context : ""}`;
    const rows = low.map(renderItemRow).join("\n");

    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.45">
        <h2 style="margin:0 0 10px">⚠️ Alerta de stock bajo</h2>
        ${context ? `<p style="margin:0 0 12px"><b>Contexto:</b> ${context}</p>` : ""}
        <table style="border-collapse:collapse;margin-top:6px">
          <thead>
            <tr>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Código</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Nombre</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:right">Stock</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:right">Mínimo</th>
              <th style="padding:6px 10px;border:1px solid #ddd;text-align:right">Diferencia</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
        <p style="margin-top:14px;color:#666">(Enviado automáticamente por tu sistema local)</p>
      </div>
    `;

    return await sendEmail({ subject, html });
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

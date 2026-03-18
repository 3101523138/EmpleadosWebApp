// Ruta: assets/facturas-liquidacion.js

//#1 import del modal de liquidación
// mueve la lógica pesada del modal interno a un archivo aparte
import { createFacturasLiquidacionModalController } from './facturas-liquidacion-modal.js';

//#2 constantes del módulo
// define tamaños, estados e ids usados por la vista principal
const MAX_FACTURAS_PENDIENTES = 50;
const LIQ_STATUS_PENDIENTE = "pendiente";
const LIQ_STATUS_RECLAMADA = "reclamada";
const FLOATING_WRAP_ID = "facturasLiqFloatingActions";
const PDF_MODAL_ID = "facturasLiqPdfModal";
const VISIBILITY_OBSERVER_ID = "__facturasLiqVisibilityObserver";

//#3 estado interno del módulo
// controla la vista activa y la carga principal del listado
const moduleState = {
  currentView: "pendientes", // "pendientes" | "mias"
  isLoading: false,
};

//#4 utilidades numéricas
// convierte valores a número seguro y evita NaN
function toNumberSafe(value) {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  return Number.isNaN(n) ? 0 : n;
}

//#5 utilidad de moneda
// formatea el monto según la moneda de la factura
function formatMoney(currency, amount) {
  const code = String(currency || "").trim().toUpperCase();
  const value = toNumberSafe(amount);

  if (code === "USD") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  return new Intl.NumberFormat("es-CR", {
    style: "currency",
    currency: "CRC",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

//#6 utilidad de fecha
// convierte issue_date a una fecha legible en español
function formatIssueDate(dateValue) {
  const raw = String(dateValue || "").trim();
  if (!raw) return "—";

  const dt = new Date(`${raw}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return raw;

  return dt.toLocaleDateString("es-CR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

//#7 utilidad de documento
// arma el texto principal de documento usando número y tipo
function formatDocumentLabel(factura) {
  const numero = String(factura?.document_number || "").trim();
  const tipo = String(factura?.document_type || "").trim();

  if (numero && tipo) return `${numero} · ${tipo}`;
  return numero || tipo || "Sin documento";
}

//#8 utilidad de proveedor
// devuelve un nombre amigable del proveedor
function formatSupplierLabel(factura) {
  const proveedor = String(factura?.supplier_name || "").trim();
  return proveedor || "Proveedor no disponible";
}

//#9 utilidad de monto
// determina qué monto mostrar en la tarjeta según la moneda
function resolveDisplayAmount(factura) {
  const currency = String(factura?.currency_code || "").trim().toUpperCase();

  if (currency === "USD") {
    return {
      currency: "USD",
      amount: toNumberSafe(factura?.amount_usd),
    };
  }

  return {
    currency: currency || "CRC",
    amount: toNumberSafe(factura?.amount_crc),
  };
}

//#10 utilidad de normalización de texto
// normaliza valores para comparar estados y cadenas de manera segura
function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

//#11 utilidad nombre empleado actual
// obtiene el nombre exacto del usuario logueado desde el contexto compartido
function getLoggedEmployeeName() {
  return String(
    window.__TMI_APP_CONTEXT__?.st?.employee?.full_name || ""
  ).trim();
}

//#12 utilidad supabase actual
// devuelve el cliente supabase desde el contexto compartido
function getSupabaseClient() {
  return window.__TMI_APP_CONTEXT__?.supabase || null;
}

//#13 utilidad proyecto texto
// arma el texto amigable de proyecto para inputs y vistas
function buildProjectText(project) {
  if (!project) return "";
  const code = String(project.project_code || "").trim();
  const name = String(project.name || project.project_name || "").trim();
  return [code, name].filter(Boolean).join(" · ");
}

//#14 utilidad resolver nombre tercero
// toma el mejor nombre visible del tercero SICLA
function resolveThirdPartyName(item) {
  if (!item || typeof item !== "object") return "";

  const candidates = [
    item.third_party_name,
    item.alias_name,
    item.name,
    item.legal_name,
    item.business_name,
    item.company_name,
    item.nombre,
    item.descripcion,
  ];

  for (const value of candidates) {
    const text = String(value || "").trim();
    if (text) return text;
  }

  return "";
}

//#15 utilidad proyecto disponible
// excluye proyectos cerrados o anulados
function isSiclaProjectAvailable(item) {
  const estado = String(item?.project_status || "").trim().toLowerCase();

  if (!estado) return true;
  if (estado.includes("cerrad")) return false;
  if (estado.includes("cancel")) return false;
  if (estado.includes("anulad")) return false;
  return true;
}

//#16 utilidad de estado visual
// resuelve el texto y estilo del estado para mostrar en la tarjeta
function resolveEstadoVisual(factura) {
  const estado = normalizeText(factura?.liq_status);
  const asignado = String(factura?.liq_assigned_to || "").trim();

  if (moduleState.currentView === "mias") {
    return {
      label: asignado ? `Reclamada por ${asignado}` : "Reclamada",
      className: "estadoReclamada",
      button: "Editar",
      buttonClassName: "facturasLiqBtnEditar",
      mode: "edit",
    };
  }

  if (!estado || estado === LIQ_STATUS_PENDIENTE) {
    return {
      label: "Pendiente",
      className: "estadoPendiente",
      button: "Liquidar",
      buttonClassName: "",
      mode: "create",
    };
  }

  if (estado === LIQ_STATUS_RECLAMADA) {
    return {
      label: asignado ? `Reclamada por ${asignado}` : "Reclamada",
      className: "estadoReclamada",
      button: "Editar",
      buttonClassName: "facturasLiqBtnEditar",
      mode: "edit",
    };
  }

  return {
    label: factura?.liq_status || "Estado no definido",
    className: "estadoOtro",
    button: "Abrir",
    buttonClassName: "",
    mode: "create",
  };
}

//#17 utilidad de PDF
// resuelve la mejor información disponible para abrir el PDF
function resolvePdfInfo(factura) {
  const googleDriveUrl = String(factura?.google_drive_url || "").trim();
  const googleDriveFileId = String(factura?.google_drive_file_id || "").trim();
  const pdfFileName = String(factura?.pdf_file_name || "").trim();

  return {
    url: googleDriveUrl,
    fileId: googleDriveFileId,
    fileName: pdfFileName || "PDF de factura",
    hasPdf: !!(googleDriveUrl || googleDriveFileId),
  };
}

//#18 utilidad URL preview de PDF
// genera la URL más adecuada para vista previa dentro del portal
function buildPdfPreviewUrl(factura) {
  const pdfInfo = resolvePdfInfo(factura);

  if (pdfInfo.fileId) {
    return `https://drive.google.com/file/d/${pdfInfo.fileId}/preview`;
  }

  if (pdfInfo.url) {
    const match = pdfInfo.url.match(/\/file\/d\/([^/]+)/i);
    if (match && match[1]) {
      return `https://drive.google.com/file/d/${match[1]}/preview`;
    }
    return pdfInfo.url;
  }

  return "";
}

//#19 utilidad visibilidad del módulo
// determina si la tarjeta de liquidación está realmente visible en pantalla
function isLiquidacionModuleVisible() {
  const card = document.getElementById("facturasLiquidacionCard");
  if (!card) return false;

  const style = window.getComputedStyle(card);
  const hiddenByStyle =
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0";

  if (hiddenByStyle) return false;
  if (card.offsetParent === null && style.position !== "fixed") return false;

  return true;
}

//#20 escapar html
// protege inserciones simples en atributos/textos
function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

//#21 mapeo de errores humanos
// convierte errores técnicos a lenguaje entendible
function mapHumanLiquidacionError(error) {
  const raw =
    String(error?.message || error?.details || error?.hint || "").trim() ||
    "No se pudo completar la operación.";

  const lower = raw.toLowerCase();

  if (lower.includes("row-level security")) {
    return "No tienes permisos para consultar o actualizar esta factura.";
  }

  if (lower.includes("violates check constraint")) {
    return "Alguno de los valores enviados no es válido para este formulario.";
  }

  if (lower.includes("invalid input syntax")) {
    return "Se envió un dato con formato incorrecto.";
  }

  if (lower.includes("network") || lower.includes("fetch")) {
    return "Hubo un problema de conexión. Intenta nuevamente.";
  }

  if (lower.includes("not exist")) {
    return "La factura o alguno de los datos requeridos ya no está disponible.";
  }

  return raw;
}

//#22 controlador externo del modal
// delega toda la lógica pesada del modal al archivo segregado
const liquidacionModalController = createFacturasLiquidacionModalController({
  getSupabaseClient,
  getLoggedEmployeeName,
  formatMoney,
  formatIssueDate,
  formatDocumentLabel,
  formatSupplierLabel,
  resolveDisplayAmount,
  resolvePdfInfo,
  buildProjectText,
  normalizeText,
  resolveThirdPartyName,
  isSiclaProjectAvailable,
  openPdfModal,
  onAfterSave: async () => {
    await reloadCurrentView();
  },
  mapHumanLiquidacionError,
});

//#23 sincronización de botones flotantes
// muestra u oculta los botones flotantes y cierra modales si la vista deja de estar activa
function syncFloatingActionsVisibility() {
  const wrap = document.getElementById(FLOATING_WRAP_ID);
  if (!wrap) return;

  const visible = isLiquidacionModuleVisible();
  wrap.style.display = visible ? "flex" : "none";

  if (!visible) {
    closePdfModal();
    liquidacionModalController.close();
  }

  syncToggleButtonLabel();
}

//#24 sincronización del botón de alternancia
// actualiza el texto del botón flotante según la vista activa
function syncToggleButtonLabel() {
  const btn = document.getElementById("facturasLiqToggleViewBtn");
  if (!btn) return;

  btn.textContent =
    moduleState.currentView === "mias" ? "Ver pendientes" : "Mis reclamadas";
}

//#25 cambio de vista
// alterna entre pendientes y reclamadas del usuario actual y recarga la lista
function toggleCurrentView() {
  if (moduleState.isLoading || liquidacionModalController.isSaving()) {
    console.log("[FACTURAS-LIQ] toggle bloqueado por carga/guardado");
    return;
  }

  moduleState.currentView =
    moduleState.currentView === "pendientes" ? "mias" : "pendientes";

  console.log("[FACTURAS-LIQ] alternando vista:", moduleState.currentView);

  syncToggleButtonLabel();
  void reloadCurrentView();
}

//#26 recarga de la vista actual
// vuelve a cargar la lista usando la vista activa del módulo
async function reloadCurrentView() {
  const supabaseClient = getSupabaseClient();
  if (!supabaseClient) {
    console.warn("[FACTURAS-LIQ] no hay supabase en contexto para recargar vista");
    return;
  }

  await loadFacturasLiquidacionView({
    supabaseClient,
  });
}

//#27 render de estado superior
// escribe mensajes superiores en el contenedor de estado
function setEstadoMessage(text) {
  const el = document.getElementById("facturasLiquidacionEstado");
  if (!el) return;
  el.textContent = text || "";
}

//#28 render de lista vacía
// muestra mensaje cuando no hay facturas según la vista activa
function renderEmptyState() {
  const list = document.getElementById("facturasLiquidacionList");
  if (!list) return;

  const mensaje =
    moduleState.currentView === "mias"
      ? "No tienes facturas reclamadas a tu nombre."
      : "No hay facturas pendientes por reclamar.";

  list.innerHTML = `
    <div class="facturasLiqEmpty">
      ${mensaje}
    </div>
  `;
}

//#29 render de carga
// muestra tarjetas esqueletales mientras la vista carga datos
function renderLoadingState() {
  const list = document.getElementById("facturasLiquidacionList");
  if (!list) return;

  list.innerHTML = `
    <div class="facturasLiqSkeleton"></div>
    <div class="facturasLiqSkeleton"></div>
    <div class="facturasLiqSkeleton"></div>
  `;
}

//#30 render de error
// muestra mensaje de error si la consulta falla
function renderErrorState(message) {
  const list = document.getElementById("facturasLiquidacionList");
  if (!list) return;

  list.innerHTML = `
    <div class="facturasLiqError">
      ${message || "Ocurrió un error cargando las facturas."}
    </div>
  `;
}

//#31 estilos locales del módulo principal
// inyecta estilos del listado, botones flotantes y visor PDF
function ensureFacturasLiquidacionStyles() {
  if (document.getElementById("facturas-liquidacion-inline-styles")) return;

  const style = document.createElement("style");
  style.id = "facturas-liquidacion-inline-styles";
  style.textContent = `
    #facturasLiquidacionCard{
      position: relative;
      width: min(1100px, calc(100vw - 32px));
      margin: 0 auto;
      padding-top: 20px;
      box-sizing: border-box;
    }

    #facturasLiquidacionEstado{
      width: 100%;
      max-width: 920px;
      margin: 0 auto 14px auto;
      text-align: center;
    }

    #facturasLiquidacionList{
      width: 100%;
      max-width: 920px;
      margin: 0 auto;
    }

    .facturasLiqFloatingWrap{
      position: fixed;
      right: 14px;
      top: 14px;
      display: none;
      flex-direction: column;
      gap: 10px;
      z-index: 2200;
    }

    .facturasLiqFloatingBtn{
      min-width: 132px;
      padding: 12px 16px;
      border: 0;
      border-radius: 14px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 6px 18px rgba(0,0,0,.14);
    }

    .facturasLiqFloatingBtn.menu{
      background: #cfd6df;
      color: #111827;
    }

    .facturasLiqFloatingBtn.logout{
      background: #ef4444;
      color: #fff;
    }

    .facturasLiqFloatingBtn.toggle{
      background: #0f172a;
      color: #fff;
    }

    .facturasLiqCard{
      background: #fff;
      border: 1px solid #d8dee8;
      border-radius: 22px;
      padding: 20px 22px 22px;
      box-shadow: 0 8px 24px rgba(15,23,42,.06);
      margin: 0 auto 14px auto;
      width: 100%;
      box-sizing: border-box;
    }

    .facturasLiqCard.facturasLiqCardCompact{
      padding: 18px 22px 20px;
    }

    .facturasLiqCardHead{
      margin-bottom: 10px;
    }

    .facturasLiqDoc{
      font-size: 1.12rem;
      font-weight: 900;
      line-height: 1.15;
      color: #0f172a;
      word-break: normal;
      overflow-wrap: normal;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .facturasLiqFecha{
      margin-top: 6px;
      font-size: .96rem;
      font-weight: 700;
      color: #6b7280;
    }

    .facturasLiqProveedor{
      font-size: 1rem;
      line-height: 1.28;
      color: #374151;
      margin-bottom: 14px;
      word-break: break-word;
    }

    .facturasLiqMontoRow{
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 14px;
      margin-bottom: 14px;
    }

    .facturasLiqMontoLabel{
      color: #6b7280;
      font-size: .96rem;
    }

    .facturasLiqMontoValue{
      color: #0f172a;
      font-size: 1.04rem;
    }

    .facturasLiqEstado{
      margin-bottom: 14px;
      font-weight: 800;
      font-size: .99rem;
    }

    .facturasLiqEstado.estadoPendiente{ color: #92400e; }
    .facturasLiqEstado.estadoReclamada{ color: #0f766e; }
    .facturasLiqEstado.estadoOtro{ color: #334155; }

    .facturasLiqActions{
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 8px;
    }

    .facturasLiqBtn{
      flex: 1 1 160px;
    }

    .facturasLiqBtnEditar{
      background: #10b981 !important;
      color: #ffffff !important;
    }

    .facturasLiqPdfBtn{
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      flex: 1 1 140px;
      min-height: 50px;
      padding: 13px 18px;
      border-radius: 14px;
      background: #e9eef5;
      color: #111827;
      font-weight: 700;
      text-decoration: none;
      border: 0;
      cursor: pointer;
    }

    .facturasLiqPdfIcon{
      font-size: 1rem;
      line-height: 1;
    }

    .facturasLiqEmpty,
    .facturasLiqError{
      padding: 18px;
      border-radius: 18px;
      border: 1px dashed #cbd5e1;
      color: #475569;
      text-align: center;
      background: #fff;
      box-sizing: border-box;
    }

    .facturasLiqSkeleton{
      height: 150px;
      border-radius: 22px;
      margin-bottom: 14px;
      background: linear-gradient(90deg, #eef2f7 25%, #f8fafc 50%, #eef2f7 75%);
      background-size: 200% 100%;
      animation: facturasLiqPulse 1.1s linear infinite;
    }

    @keyframes facturasLiqPulse {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }

    .facturasLiqPdfModalBack{
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, .55);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 12px;
      z-index: 2300;
    }

    .facturasLiqPdfModal{
      width: min(1100px, 100%);
      height: min(92vh, 860px);
      background: #fff;
      border-radius: 20px;
      box-shadow: 0 20px 54px rgba(15, 23, 42, 0.28);
      border: 1px solid #e5e7eb;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .facturasLiqPdfModalHeader{
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid #e5e7eb;
      background: #f8fafc;
    }

    .facturasLiqPdfModalTitle{
      font-size: .96rem;
      font-weight: 800;
      color: #0f172a;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .facturasLiqPdfModalActions{
      display: flex;
      gap: 8px;
      flex-shrink: 0;
    }

    .facturasLiqPdfModalBtn{
      padding: 10px 14px;
      border-radius: 12px;
      border: 0;
      cursor: pointer;
      font-weight: 700;
    }

    .facturasLiqPdfModalBtn.open{
      background: #e9eef5;
      color: #111827;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .facturasLiqPdfModalBtn.close{
      background: #0f172a;
      color: #fff;
    }

    .facturasLiqPdfModalBody{
      flex: 1;
      background: #fff;
    }

    .facturasLiqPdfFrame{
      width: 100%;
      height: 100%;
      border: 0;
      background: #fff;
    }

    @media (max-width: 900px) {
      #facturasLiquidacionCard{
        width: min(100%, calc(100vw - 20px));
      }

      #facturasLiquidacionEstado,
      #facturasLiquidacionList{
        max-width: 100%;
      }

      .facturasLiqDoc{
        white-space: normal;
        overflow: visible;
        text-overflow: initial;
        word-break: break-word;
        overflow-wrap: anywhere;
      }
    }

    @media (max-width: 640px) {
      .facturasLiqFloatingWrap{
        right: 10px;
        top: 10px;
      }

      .facturasLiqFloatingBtn{
        min-width: 122px;
        padding: 11px 14px;
      }

      .facturasLiqCard{
        padding: 16px 16px 18px;
      }

      .facturasLiqCard.facturasLiqCardCompact{
        padding: 16px 16px 18px;
      }

      .facturasLiqPdfModal{
        height: 94vh;
        border-radius: 16px;
      }

      .facturasLiqPdfModalHeader{
        flex-direction: column;
        align-items: stretch;
      }

      .facturasLiqPdfModalActions{
        width: 100%;
      }

      .facturasLiqPdfModalBtn{
        flex: 1 1 0;
      }
    }
  `;
  document.head.appendChild(style);
}

//#32 botones flotantes del módulo
// crea botones flotantes de menú, salir y alternancia de vista visibles solo cuando la vista está activa
function ensureFloatingActions() {
  ensureFacturasLiquidacionStyles();

  let wrap = document.getElementById(FLOATING_WRAP_ID);
  if (wrap) {
    syncFloatingActionsVisibility();
    return;
  }

  wrap = document.createElement("div");
  wrap.id = FLOATING_WRAP_ID;
  wrap.className = "facturasLiqFloatingWrap";

  const btnMenu = document.createElement("button");
  btnMenu.type = "button";
  btnMenu.className = "facturasLiqFloatingBtn menu";
  btnMenu.textContent = "← Menú";
  btnMenu.addEventListener("click", () => {
    const ctx = window.__TMI_APP_CONTEXT__;
    if (ctx?.routeTo) {
      ctx.routeTo("/app");
      return;
    }
    const navBtn = document.querySelector('[data-nav="/app"]');
    if (navBtn) navBtn.click();
  });

  const btnToggle = document.createElement("button");
  btnToggle.type = "button";
  btnToggle.id = "facturasLiqToggleViewBtn";
  btnToggle.className = "facturasLiqFloatingBtn toggle";
  btnToggle.textContent = "Mis reclamadas";
  btnToggle.addEventListener("click", () => {
    toggleCurrentView();
  });

  const btnSalir = document.createElement("button");
  btnSalir.type = "button";
  btnSalir.className = "facturasLiqFloatingBtn logout";
  btnSalir.textContent = "Salir";
  btnSalir.addEventListener("click", () => {
    const logoutBtn =
      document.getElementById("btnLogout2") ||
      document.getElementById("btnLogout");
    if (logoutBtn) {
      logoutBtn.click();
    }
  });

  wrap.appendChild(btnMenu);
  wrap.appendChild(btnToggle);
  wrap.appendChild(btnSalir);
  document.body.appendChild(wrap);

  syncFloatingActionsVisibility();
}

//#33 observer de visibilidad
// observa cambios mínimos de visibilidad para ocultar los botones al salir del módulo
function ensureVisibilityObserver() {
  if (window[VISIBILITY_OBSERVER_ID]) return;

  const card = document.getElementById("facturasLiquidacionCard");
  if (!card) return;

  const observer = new MutationObserver(() => {
    syncFloatingActionsVisibility();
  });

  observer.observe(card, {
    attributes: true,
    attributeFilter: ["style", "class"],
  });

  window.addEventListener("popstate", syncFloatingActionsVisibility);
  document.addEventListener("visibilitychange", syncFloatingActionsVisibility);

  window[VISIBILITY_OBSERVER_ID] = {
    observer,
  };

  syncFloatingActionsVisibility();
}

//#34 modal PDF
// crea una sola vez el visor modal de PDF dentro del portal
function ensurePdfModal() {
  ensureFacturasLiquidacionStyles();

  let modal = document.getElementById(PDF_MODAL_ID);
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = PDF_MODAL_ID;
  modal.className = "facturasLiqPdfModalBack";
  modal.innerHTML = `
    <div class="facturasLiqPdfModal" role="dialog" aria-modal="true" aria-label="Visor de PDF">
      <div class="facturasLiqPdfModalHeader">
        <div class="facturasLiqPdfModalTitle" id="facturasLiqPdfModalTitle">PDF de factura</div>
        <div class="facturasLiqPdfModalActions">
          <a
            id="facturasLiqPdfModalOpen"
            class="facturasLiqPdfModalBtn open"
            href="#"
            target="_blank"
            rel="noopener noreferrer"
          >
            Abrir fuera
          </a>
          <button
            id="facturasLiqPdfModalClose"
            type="button"
            class="facturasLiqPdfModalBtn close"
          >
            Cerrar
          </button>
        </div>
      </div>
      <div class="facturasLiqPdfModalBody" id="facturasLiqPdfModalBody">
        <iframe
          id="facturasLiqPdfFrame"
          class="facturasLiqPdfFrame"
          title="Vista previa PDF"
          src=""
        ></iframe>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  const closeBtn = modal.querySelector("#facturasLiqPdfModalClose");
  closeBtn.addEventListener("click", closePdfModal);

  modal.addEventListener("click", (e) => {
    if (e.target === modal) closePdfModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePdfModal();
  });

  return modal;
}

//#35 abrir visor PDF
// abre el PDF en un modal dentro del portal usando preview de Drive si es posible
function openPdfModal(factura) {
  const modal = ensurePdfModal();
  const previewUrl = buildPdfPreviewUrl(factura);
  const pdfInfo = resolvePdfInfo(factura);

  if (!previewUrl) {
    console.warn("[FACTURAS-LIQ] la factura no tiene PDF disponible:", factura?.id);
    return;
  }

  const titleEl = modal.querySelector("#facturasLiqPdfModalTitle");
  const openEl = modal.querySelector("#facturasLiqPdfModalOpen");
  const bodyEl = modal.querySelector("#facturasLiqPdfModalBody");

  if (titleEl) {
    titleEl.textContent = pdfInfo.fileName || `PDF · ${formatDocumentLabel(factura)}`;
  }

  if (openEl) {
    openEl.href = previewUrl;
  }

  if (bodyEl) {
    bodyEl.innerHTML = `
      <iframe
        id="facturasLiqPdfFrame"
        class="facturasLiqPdfFrame"
        title="Vista previa PDF"
        src="${previewUrl}"
      ></iframe>
    `;
  }

  modal.style.display = "flex";
  document.body.style.overflow = "hidden";

  console.log("[FACTURAS-LIQ] abriendo visor modal PDF:", {
    facturaId: factura?.id,
    previewUrl,
  });
}

//#36 cerrar visor PDF
// cierra el modal PDF y limpia el iframe para detener la carga
function closePdfModal() {
  const modal = document.getElementById(PDF_MODAL_ID);
  if (!modal || modal.style.display === "none") return;

  const bodyEl = modal.querySelector("#facturasLiqPdfModalBody");
  if (bodyEl) {
    bodyEl.innerHTML = `
      <iframe
        id="facturasLiqPdfFrame"
        class="facturasLiqPdfFrame"
        title="Vista previa PDF"
        src=""
      ></iframe>
    `;
  }

  modal.style.display = "none";
  document.body.style.overflow = liquidacionModalController.isOpen() ? "hidden" : "";
}

//#37 apertura de liquidación
// reemplaza la URL externa por el modal interno segregado
function abrirFormularioLiquidacion(factura) {
  void liquidacionModalController.open(factura);
}

//#38 creación de tarjeta para pendientes
// construye una tarjeta completa con datos, estado, PDF y botón de liquidar
function createPendienteCard(factura) {
  const wrapper = document.createElement("div");
  wrapper.className = "facturasLiqCard";

  const { currency, amount } = resolveDisplayAmount(factura);
  const montoTexto = formatMoney(currency, amount);
  const estadoVisual = resolveEstadoVisual(factura);
  const pdfInfo = resolvePdfInfo(factura);

  wrapper.innerHTML = `
    <div class="facturasLiqCardHead">
      <div class="facturasLiqDoc" title="${escapeHtml(formatDocumentLabel(factura))}">${escapeHtml(formatDocumentLabel(factura))}</div>
      <div class="facturasLiqFecha">${escapeHtml(formatIssueDate(factura?.issue_date))}</div>
    </div>

    <div class="facturasLiqProveedor">${escapeHtml(formatSupplierLabel(factura))}</div>

    <div class="facturasLiqMontoRow">
      <span class="facturasLiqMontoLabel">Monto</span>
      <strong class="facturasLiqMontoValue">${escapeHtml(montoTexto)}</strong>
    </div>

    <div class="facturasLiqEstado ${estadoVisual.className}">
      ${escapeHtml(estadoVisual.label)}
    </div>

    <div class="facturasLiqActions">
      <button class="btn facturasLiqBtn ${estadoVisual.buttonClassName || ""}" type="button">${escapeHtml(estadoVisual.button)}</button>
      ${
        pdfInfo.hasPdf
          ? `
            <button class="facturasLiqPdfBtn" type="button">
              <span class="facturasLiqPdfIcon">📄</span>
              <span>Ver PDF</span>
            </button>
          `
          : ""
      }
    </div>
  `;

  const liquidarBtn = wrapper.querySelector(".facturasLiqBtn");
  liquidarBtn.addEventListener("click", () => {
    abrirFormularioLiquidacion(factura);
  });

  const pdfBtn = wrapper.querySelector(".facturasLiqPdfBtn");
  if (pdfBtn) {
    pdfBtn.addEventListener("click", () => {
      openPdfModal(factura);
    });
  }

  return wrapper;
}

//#39 creación de tarjeta para reclamadas mías
// construye una tarjeta compacta con documento y botón de edición
function createReclamadaMiaCard(factura) {
  const wrapper = document.createElement("div");
  wrapper.className = "facturasLiqCard facturasLiqCardCompact";

  wrapper.innerHTML = `
    <div class="facturasLiqCardHead">
      <div class="facturasLiqDoc" title="${escapeHtml(formatDocumentLabel(factura))}">${escapeHtml(formatDocumentLabel(factura))}</div>
      <div class="facturasLiqFecha">${escapeHtml(formatIssueDate(factura?.issue_date))}</div>
    </div>

    <div class="facturasLiqActions">
      <button class="btn facturasLiqBtn facturasLiqBtnEditar" type="button">Editar</button>
    </div>
  `;

  const editarBtn = wrapper.querySelector(".facturasLiqBtn");
  editarBtn.addEventListener("click", () => {
    abrirFormularioLiquidacion(factura);
  });

  return wrapper;
}

//#40 creación de tarjeta según vista
// selecciona el formato correcto de tarjeta dependiendo de la vista activa
function createFacturaCard({ factura }) {
  if (moduleState.currentView === "mias") {
    return createReclamadaMiaCard(factura);
  }

  return createPendienteCard(factura);
}

//#41 render principal de facturas
// dibuja toda la lista según la vista activa
function renderFacturasList({ facturas }) {
  const list = document.getElementById("facturasLiquidacionList");
  if (!list) return;

  list.innerHTML = "";

  if (!Array.isArray(facturas) || !facturas.length) {
    renderEmptyState();
    return;
  }

  const frag = document.createDocumentFragment();

  facturas.forEach((factura) => {
    const card = createFacturaCard({ factura });
    frag.appendChild(card);
  });

  list.appendChild(frag);
}

//#42 consulta de pendientes
// consulta directamente a la BD solo las facturas pendientes visibles
async function fetchPendientesDirecto(supabaseClient) {
  console.log("[FACTURAS-LIQ] consultando pendientes directo...");

  const { data, error } = await supabaseClient
    .schema("inv")
    .from("invoice_documents")
    .select(`
      id,
      issue_date,
      document_number,
      document_type,
      supplier_name,
      currency_code,
      amount_crc,
      amount_usd,
      liq_status,
      liq_assigned_to,
      google_drive_url,
      google_drive_file_id,
      pdf_file_name,
      client_name,
      project_code,
      project_name,
      capa,
      liq_type,
      liq_comments,
      created_at
    `)
    .or("liq_status.is.null,liq_status.eq.,liq_status.ilike.pendiente")
    .or("liq_assigned_to.is.null,liq_assigned_to.eq.")
    .order("issue_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(MAX_FACTURAS_PENDIENTES);

  if (error) {
    console.error("[FACTURAS-LIQ] error consultando pendientes directo:", error);
    throw error;
  }

  const facturas = Array.isArray(data) ? data : [];

  console.log("[FACTURAS-LIQ] pendientes cargadas:", facturas.length);
  return facturas;
}

//#43 consulta de reclamadas del usuario
// consulta directamente a la BD solo las facturas reclamadas por el usuario logueado
async function fetchReclamadasMiasDirecto(supabaseClient, employeeName) {
  console.log("[FACTURAS-LIQ] consultando reclamadas del usuario:", employeeName);

  if (!employeeName) {
    return [];
  }

  const { data, error } = await supabaseClient
    .schema("inv")
    .from("invoice_documents")
    .select(`
      id,
      issue_date,
      document_number,
      document_type,
      supplier_name,
      currency_code,
      amount_crc,
      amount_usd,
      liq_status,
      liq_assigned_to,
      google_drive_url,
      google_drive_file_id,
      pdf_file_name,
      client_name,
      project_code,
      project_name,
      capa,
      liq_type,
      liq_comments,
      created_at
    `)
    .ilike("liq_status", "Reclamada")
    .eq("liq_assigned_to", employeeName)
    .order("issue_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(MAX_FACTURAS_PENDIENTES);

  if (error) {
    console.error("[FACTURAS-LIQ] error consultando reclamadas del usuario:", error);
    throw error;
  }

  const facturas = Array.isArray(data) ? data : [];

  console.log("[FACTURAS-LIQ] reclamadas mías cargadas:", facturas.length);
  return facturas;
}

//#44 mensaje superior según vista
// construye el texto del encabezado para pendientes o reclamadas del usuario
function buildHeaderMessage(total, employeeName) {
  if (moduleState.currentView === "mias") {
    if (!total) return "No tienes facturas reclamadas a tu nombre.";
    return `Mostrando ${total} factura(s) reclamada(s) a nombre de ${employeeName}.`;
  }

  if (!total) return "No hay facturas pendientes.";
  return `Mostrando ${total} factura(s) pendiente(s).`;
}

//#45 inicialización del módulo
// valida presencia del DOM, inyecta estilos y deja listos los botones flotantes y modales
export function initFacturasLiquidacionModule() {
  console.log("[FACTURAS-LIQ] initFacturasLiquidacionModule");

  const card = document.getElementById("facturasLiquidacionCard");
  const list = document.getElementById("facturasLiquidacionList");
  const estado = document.getElementById("facturasLiquidacionEstado");

  if (!card || !list || !estado) {
    console.warn("[FACTURAS-LIQ] faltan contenedores del módulo en index.html");
    return false;
  }

  ensureFacturasLiquidacionStyles();
  ensureFloatingActions();
  ensureVisibilityObserver();
  ensurePdfModal();
  liquidacionModalController.ensure();
  syncFloatingActionsVisibility();

  return true;
}

//#46 carga principal de la vista
// consulta directo a la BD según la vista activa y renderiza la lista
export async function loadFacturasLiquidacionView({
  supabaseClient,
}) {
  console.log("[FACTURAS-LIQ] loadFacturasLiquidacionView start", {
    currentView: moduleState.currentView,
  });

  if (moduleState.isLoading) {
    console.log("[FACTURAS-LIQ] carga ignorada porque ya hay una en progreso");
    return;
  }

  moduleState.isLoading = true;

  try {
    setEstadoMessage("Cargando facturas...");
    renderLoadingState();
    syncFloatingActionsVisibility();

    const employeeName = getLoggedEmployeeName();
    let facturas = [];

    if (moduleState.currentView === "mias") {
      facturas = await fetchReclamadasMiasDirecto(supabaseClient, employeeName);
    } else {
      facturas = await fetchPendientesDirecto(supabaseClient);
    }

    setEstadoMessage(buildHeaderMessage(facturas.length, employeeName));
    renderFacturasList({ facturas });
    syncFloatingActionsVisibility();
  } catch (err) {
    console.error("[FACTURAS-LIQ] load error:", err);
    setEstadoMessage("No fue posible cargar las facturas.");
    renderErrorState(err?.message || "Error cargando las facturas.");
    syncFloatingActionsVisibility();
  } finally {
    moduleState.isLoading = false;
  }
}
// Ruta: assets/facturas-liquidacion-modal.js

//#1 constantes internas del modal
// define ids, opciones y límites de la UI de liquidación
const LIQ_MODAL_ID = "facturasLiqEditModal";
const LIQ_MODAL_CSS_ID = "facturas-liquidacion-modal-css-link";
const PDF_MODAL_ID = "facturasLiqPdfModal";

const OPCIONES_LIQ_TYPE = [
  "Tarjeta TMI",
  "Credito TMI",
  "Deposito TMI",
  "Personal",
];

const OPCIONES_CAPA = [
  "Materiales",
  "Subcontrato",
  "Alquiler",
  "Equipos",
  "Entrenamiento",
  "Otros",
];

//#2 fábrica del controlador del modal
// encapsula estado, render, carga de catálogos y guardado del modal
export function createFacturasLiquidacionModalController({
  getSupabaseClient,
  getLoggedEmployeeName,
  openPdfModal,
  onAfterSave,
  logPrefix = "[FACTURAS-LIQ-MODAL]",
} = {}) {
  //#3 estado interno privado
  // conserva catálogos y factura activa sin contaminar otros módulos
  const state = {
    proyectosSicla: [],
    empleadosActivos: [],
    catalogsLoaded: false,
    modalOpen: false,
    guardando: false,
    facturaActual: null,
    hiddenForPdf: false,
    pdfObserver: null,
    pdfBridgeBound: false,
  };

  //#4 utilidades base
  // pequeños helpers internos reutilizados por el modal
  function log(...args) {
    console.log(logPrefix, ...args);
  }

  function logError(...args) {
    console.error(logPrefix, ...args);
  }

  function getSupabase() {
    const client =
      typeof getSupabaseClient === "function" ? getSupabaseClient() : null;

    if (!client) {
      throw new Error("No hay conexión disponible para abrir la liquidación.");
    }

    return client;
  }

  function getEmployeeName() {
    return String(
      typeof getLoggedEmployeeName === "function" ? getLoggedEmployeeName() : ""
    ).trim();
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function normalizeText(value) {
    return String(value || "").trim().toLowerCase();
  }

  function toNumberSafe(value) {
    if (value === null || value === undefined || value === "") return 0;
    const n = Number(value);
    return Number.isNaN(n) ? 0 : n;
  }

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

  function resolveDisplayAmount(factura) {
    const currency = String(factura?.currency_code || "")
      .trim()
      .toUpperCase();

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

  function formatSupplierLabel(factura) {
    return String(factura?.supplier_name || "").trim() || "Proveedor no disponible";
  }

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

  function isSiclaProjectAvailable(item) {
    const estado = String(item?.project_status || "").trim().toLowerCase();

    if (!estado) return true;
    if (estado.includes("cerrad")) return false;
    if (estado.includes("cancel")) return false;
    if (estado.includes("anulad")) return false;
    return true;
  }

  function buildProjectText(project) {
    if (!project) return "";
    const code = String(project.project_code || "").trim();
    const name = String(project.name || project.project_name || "").trim();
    return [code, name].filter(Boolean).join(" · ");
  }

  function resolveLiquidacionEstadoVisible(factura) {
    const valor = String(factura?.liq_status || "").trim();
    if (!valor) return "Pendiente";
    if (normalizeText(valor) === "revision") return "Reclamada";
    return valor;
  }

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

  //#5 asegurar hoja de estilos externa
  // enlaza el css exclusivo del modal una sola vez
  function ensureStylesheet() {
    if (document.getElementById(LIQ_MODAL_CSS_ID)) return;

    const link = document.createElement("link");
    link.id = LIQ_MODAL_CSS_ID;
    link.rel = "stylesheet";
    link.href = new URL("./facturas-liquidacion-modal.css", import.meta.url).href;
    document.head.appendChild(link);

    log("css externo del modal enlazado");
  }

  //#6 helpers de puente con PDF
  // oculta temporalmente el modal de liquidación para que el visor PDF quede al frente
  function getModalRoot() {
    return document.getElementById(LIQ_MODAL_ID);
  }

  function getPdfRoot() {
    return document.getElementById(PDF_MODAL_ID);
  }

  function hideForPdf() {
    const modal = getModalRoot();
    if (!modal || !state.modalOpen) return;

    state.hiddenForPdf = true;
    modal.style.visibility = "hidden";
    modal.style.pointerEvents = "none";
    modal.setAttribute("data-hidden-for-pdf", "1");

    log("modal oculto temporalmente para mostrar PDF al frente");
  }

  function restoreAfterPdf() {
    const modal = getModalRoot();
    if (!modal) return;
    if (!state.modalOpen) return;
    if (!state.hiddenForPdf) return;

    modal.style.visibility = "";
    modal.style.pointerEvents = "";
    modal.removeAttribute("data-hidden-for-pdf");
    state.hiddenForPdf = false;

    log("modal restaurado después de cerrar PDF");
  }

  function syncWithPdfVisibility() {
    const pdfModal = getPdfRoot();
    if (!pdfModal) {
      restoreAfterPdf();
      return;
    }

    const visible = pdfModal.style.display === "flex";
    if (!visible) {
      restoreAfterPdf();
    }
  }

  function observePdfModal(pdfModal) {
    if (!pdfModal) return;
    if (state.pdfObserver) {
      state.pdfObserver.disconnect();
      state.pdfObserver = null;
    }

    state.pdfObserver = new MutationObserver(() => {
      syncWithPdfVisibility();
    });

    state.pdfObserver.observe(pdfModal, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });

    log("observer del visor PDF conectado");
  }

  function ensurePdfBridge() {
    if (state.pdfBridgeBound) return;
    state.pdfBridgeBound = true;

    const bootObserve = () => {
      const pdfModal = getPdfRoot();
      if (pdfModal) observePdfModal(pdfModal);
    };

    bootObserve();

    const bodyObserver = new MutationObserver(() => {
      const pdfModal = getPdfRoot();
      if (pdfModal && !state.pdfObserver) {
        observePdfModal(pdfModal);
      }
    });

    bodyObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    document.addEventListener("keydown", () => {
      setTimeout(syncWithPdfVisibility, 30);
    });

    document.addEventListener("click", () => {
      setTimeout(syncWithPdfVisibility, 30);
    });

    log("puente modal liquidación ↔ visor PDF listo");
  }

  function openPdfFromLiquidacion() {
    if (!state.facturaActual) return;
    if (typeof openPdfModal !== "function") return;

    hideForPdf();
    openPdfModal(state.facturaActual);

    setTimeout(() => {
      const pdfModal = getPdfRoot();
      if (pdfModal) {
        observePdfModal(pdfModal);
        syncWithPdfVisibility();
      } else {
        restoreAfterPdf();
      }
    }, 60);
  }

  //#7 asegurar estructura DOM
  // crea el modal una sola vez y conecta eventos base
  function ensureModal() {
    ensureStylesheet();
    ensurePdfBridge();

    let modal = document.getElementById(LIQ_MODAL_ID);
    if (modal) return modal;

    modal = document.createElement("div");
    modal.id = LIQ_MODAL_ID;
    modal.className = "facturasLiqEditModalBack";
    modal.innerHTML = `
      <div class="facturasLiqEditModal" role="dialog" aria-modal="true" aria-label="Liquidación de factura">
        <div class="facturasLiqEditHead">
          <div class="facturasLiqEditHeadText">
            <h3>Liquidación de factura</h3>
            <p class="facturasLiqEditDoc" id="facturasLiqEditDoc">Sin documento</p>
          </div>
          <button
            id="facturasLiqEditCloseBtn"
            type="button"
            class="facturasLiqModalCloseBtn"
          >
            Cerrar
          </button>
        </div>

        <div class="facturasLiqEditBody">
          <section class="facturasLiqEditSection">
            <div class="facturasLiqEditSectionHead">
              <h4>Resumen del documento</h4>
              <span class="facturasLiqEditHint">Revisa la factura antes de asignar la liquidación</span>
            </div>

            <div class="facturasLiqEditTop">
              <div class="facturasLiqEditDocBox">
                <span class="facturasLiqEditLabel">Documento</span>
                <strong class="facturasLiqEditDocValue" id="facturasLiqEditDocValue">Sin consecutivo</strong>
              </div>

              <button
                id="facturasLiqEditPdfBtn"
                type="button"
                class="facturasLiqModalBtn facturasLiqModalBtnDark"
              >
                Ver PDF
              </button>
            </div>

            <div class="facturasLiqEditInfoGrid">
              <div class="facturasLiqEditInfoPill">
                <span class="facturasLiqEditLabel">Fecha</span>
                <strong id="facturasLiqEditFecha">—</strong>
              </div>
              <div class="facturasLiqEditInfoPill">
                <span class="facturasLiqEditLabel">Proveedor</span>
                <strong id="facturasLiqEditProveedor">—</strong>
              </div>
              <div class="facturasLiqEditInfoPill">
                <span class="facturasLiqEditLabel">Monto</span>
                <strong id="facturasLiqEditMonto">—</strong>
              </div>
              <div class="facturasLiqEditInfoPill">
                <span class="facturasLiqEditLabel">Estado liquidación</span>
                <strong id="facturasLiqEditEstadoVisible">Pendiente</strong>
              </div>
            </div>
          </section>

          <section class="facturasLiqEditSection">
            <div class="facturasLiqEditSectionHead">
              <h4>Datos actuales</h4>
              <span class="facturasLiqEditHint">Cliente, proyecto y contexto actual de la factura</span>
            </div>

            <div class="facturasLiqEditInfoGridThree">
              <div class="facturasLiqEditInfoPill">
                <span class="facturasLiqEditLabel">Cliente actual</span>
                <strong id="facturasLiqEditClienteActual">—</strong>
              </div>

              <div class="facturasLiqEditInfoPill">
                <span class="facturasLiqEditLabel">Proyecto actual</span>
                <div class="facturasLiqEditProjectInline">
                  <span class="facturasLiqEditProjectCode" id="facturasLiqEditProyectoCode">—</span>
                  <span class="facturasLiqEditProjectName" id="facturasLiqEditProyectoName">Sin proyecto</span>
                  <span class="facturasLiqEditProjectStatus" id="facturasLiqEditProyectoStatus">Sin estado</span>
                </div>
              </div>

              <div class="facturasLiqEditInfoPill">
                <span class="facturasLiqEditLabel">Capa actual</span>
                <strong id="facturasLiqEditCapaActual">Sin capa asignada</strong>
              </div>
            </div>
          </section>

          <section class="facturasLiqEditSection">
            <div class="facturasLiqEditSectionHead">
              <h4>Asignación de liquidación</h4>
              <span class="facturasLiqEditHint">Cliente, proyecto, capa, responsable y tipo</span>
            </div>

            <div class="facturasLiqEditGridTwo">
              <div class="facturasLiqField">
                <label class="facturasLiqFieldLabel" for="facturasLiqClienteInput">Cliente</label>
                <div class="facturasLiqComboWrap">
                  <div class="facturasLiqInputActionRow">
                    <input
                      id="facturasLiqClienteInput"
                      class="facturasLiqInput"
                      type="text"
                      autocomplete="off"
                      placeholder="Buscar cliente..."
                    />
                    <button
                      id="facturasLiqClearClienteBtn"
                      type="button"
                      class="facturasLiqModalBtn facturasLiqModalBtnLight"
                    >
                      Limpiar
                    </button>
                  </div>
                  <div id="facturasLiqClienteDropdown" class="facturasLiqComboDrop" style="display:none;"></div>
                </div>
              </div>

              <div class="facturasLiqField">
                <label class="facturasLiqFieldLabel" for="facturasLiqProyectoInput">Proyecto</label>
                <div class="facturasLiqComboWrap">
                  <div class="facturasLiqInputActionRow">
                    <input
                      id="facturasLiqProyectoInput"
                      class="facturasLiqInput"
                      type="text"
                      autocomplete="off"
                      placeholder="Buscar por código o nombre SICLA..."
                    />
                    <button
                      id="facturasLiqClearProyectoBtn"
                      type="button"
                      class="facturasLiqModalBtn facturasLiqModalBtnLight"
                    >
                      Limpiar
                    </button>
                  </div>
                  <div id="facturasLiqProyectoDropdown" class="facturasLiqComboDrop" style="display:none;"></div>
                </div>
              </div>
            </div>

            <div class="facturasLiqEditGridThree">
              <div class="facturasLiqField">
                <label class="facturasLiqFieldLabel" for="facturasLiqCapaSelect">Capa</label>
                <select id="facturasLiqCapaSelect" class="facturasLiqSelect"></select>
              </div>

              <div class="facturasLiqField">
                <label class="facturasLiqFieldLabel" for="facturasLiqResponsableSelect">Reclamada por</label>
                <select id="facturasLiqResponsableSelect" class="facturasLiqSelect"></select>
              </div>

              <div class="facturasLiqField">
                <label class="facturasLiqFieldLabel" for="facturasLiqEstadoInput">Estado liquidación</label>
                <input id="facturasLiqEstadoInput" class="facturasLiqInput" type="text" readonly />
              </div>
            </div>

            <div class="facturasLiqField">
              <label class="facturasLiqFieldLabel" for="facturasLiqTipoSelect">Tipo liquidación</label>
              <select id="facturasLiqTipoSelect" class="facturasLiqSelect"></select>
            </div>

            <div class="facturasLiqField">
              <label class="facturasLiqFieldLabel" for="facturasLiqComentarioInput">Comentario esquema liquidación</label>
              <textarea
                id="facturasLiqComentarioInput"
                class="facturasLiqTextarea"
                rows="1"
                placeholder="Observaciones del esquema de liquidación..."
              ></textarea>
            </div>
          </section>

          <div id="facturasLiqModalInfo" class="facturasLiqModalMsgInfo" style="display:none;"></div>
          <div id="facturasLiqModalError" class="facturasLiqModalMsgErr" style="display:none;"></div>
          <div id="facturasLiqModalOk" class="facturasLiqModalMsgOk" style="display:none;"></div>

          <div class="facturasLiqEditFooter">
            <button
              id="facturasLiqVolverBtn"
              type="button"
              class="facturasLiqModalBtn facturasLiqModalBtnLight"
            >
              Volver a factura
            </button>

            <div class="facturasLiqEditFooterRight">
              <button
                id="facturasLiqGuardarBtn"
                type="button"
                class="facturasLiqModalBtn facturasLiqModalBtnBlue"
              >
                Guardar liquidación
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    modal.addEventListener("click", (e) => {
      if (e.target === modal && !state.guardando) {
        close();
      }
    });

    modal.querySelector("#facturasLiqEditCloseBtn")?.addEventListener("click", () => {
      if (state.guardando) return;
      close();
    });

    modal.querySelector("#facturasLiqVolverBtn")?.addEventListener("click", () => {
      if (state.guardando) return;
      close();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.modalOpen && !state.guardando) {
        close();
      }
    });

    return modal;
  }

  //#8 obtener referencias del modal
  // centraliza el acceso a nodos para evitar querySelector repetidos en todo lado
  function getEls() {
    const modal = document.getElementById(LIQ_MODAL_ID);
    if (!modal) return null;

    return {
      modal,
      docSmall: modal.querySelector("#facturasLiqEditDoc"),
      docBig: modal.querySelector("#facturasLiqEditDocValue"),
      fecha: modal.querySelector("#facturasLiqEditFecha"),
      proveedor: modal.querySelector("#facturasLiqEditProveedor"),
      monto: modal.querySelector("#facturasLiqEditMonto"),
      estadoVisible: modal.querySelector("#facturasLiqEditEstadoVisible"),
      clienteActual: modal.querySelector("#facturasLiqEditClienteActual"),
      proyectoCode: modal.querySelector("#facturasLiqEditProyectoCode"),
      proyectoName: modal.querySelector("#facturasLiqEditProyectoName"),
      proyectoStatus: modal.querySelector("#facturasLiqEditProyectoStatus"),
      capaActual: modal.querySelector("#facturasLiqEditCapaActual"),
      pdfBtn: modal.querySelector("#facturasLiqEditPdfBtn"),
      clienteInput: modal.querySelector("#facturasLiqClienteInput"),
      clearClienteBtn: modal.querySelector("#facturasLiqClearClienteBtn"),
      clienteDrop: modal.querySelector("#facturasLiqClienteDropdown"),
      proyectoInput: modal.querySelector("#facturasLiqProyectoInput"),
      clearProyectoBtn: modal.querySelector("#facturasLiqClearProyectoBtn"),
      proyectoDrop: modal.querySelector("#facturasLiqProyectoDropdown"),
      capaSelect: modal.querySelector("#facturasLiqCapaSelect"),
      responsableSelect: modal.querySelector("#facturasLiqResponsableSelect"),
      estadoInput: modal.querySelector("#facturasLiqEstadoInput"),
      tipoSelect: modal.querySelector("#facturasLiqTipoSelect"),
      comentarioInput: modal.querySelector("#facturasLiqComentarioInput"),
      guardarBtn: modal.querySelector("#facturasLiqGuardarBtn"),
      infoBox: modal.querySelector("#facturasLiqModalInfo"),
      errorBox: modal.querySelector("#facturasLiqModalError"),
      okBox: modal.querySelector("#facturasLiqModalOk"),
    };
  }

  //#9 mensajes del modal
  // muestra feedback en azul, rojo o verde según el caso
  function setMessage(type, text) {
    const els = getEls();
    if (!els) return;

    [els.infoBox, els.errorBox, els.okBox].forEach((box) => {
      if (!box) return;
      box.style.display = "none";
      box.textContent = "";
    });

    if (!type || !text) return;

    const target =
      type === "error"
        ? els.errorBox
        : type === "ok"
        ? els.okBox
        : els.infoBox;

    if (!target) return;
    target.textContent = text;
    target.style.display = "";
  }

  //#10 catálogos
  // carga proyectos SICLA y empleados activos una sola vez
  async function ensureCatalogs() {
    if (state.catalogsLoaded) return;

    const supabase = getSupabase();

    log("cargando catálogos del modal...");

    const [proyectosRes, tercerosRes, empleadosRes] = await Promise.all([
      supabase
        .schema("sicla")
        .from("projects")
        .select(`
          source_id,
          project_code,
          project_name,
          third_party_id,
          project_status
        `)
        .order("project_code", { ascending: true }),
      supabase
        .schema("sicla")
        .from("third_parties")
        .select("*"),
      supabase
        .schema("public")
        .from("employees")
        .select("full_name, status")
        .eq("status", "Activo")
        .order("full_name", { ascending: true }),
    ]);

    if (proyectosRes.error) {
      logError("error sicla.projects:", proyectosRes.error);
      throw proyectosRes.error;
    }

    if (tercerosRes.error) {
      logError("error sicla.third_parties:", tercerosRes.error);
    }

    if (empleadosRes.error) {
      logError("error employees:", empleadosRes.error);
    }

    const thirdPartyMap = new Map();
    (tercerosRes.data || []).forEach((item) => {
      const sourceId = String(item?.source_id ?? "").trim();
      if (!sourceId) return;
      thirdPartyMap.set(sourceId, resolveThirdPartyName(item));
    });

    state.proyectosSicla = (proyectosRes.data || [])
      .filter(isSiclaProjectAvailable)
      .map((item) => {
        const thirdPartyId = String(item?.third_party_id ?? "").trim();

        return {
          source_id: item?.source_id ?? null,
          project_code: String(item?.project_code || "").trim(),
          name: String(item?.project_name || "").trim(),
          client_name: String(thirdPartyMap.get(thirdPartyId) || "").trim(),
          project_status: String(item?.project_status || "").trim(),
        };
      })
      .filter((item) => item.project_code);

    const ownName = getEmployeeName();
    const names = Array.from(
      new Set(
        [...(empleadosRes.data || []).map((x) => String(x?.full_name || "").trim()), ownName].filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b, "es"));

    state.empleadosActivos = names;
    state.catalogsLoaded = true;

    log("catálogos cargados:", {
      proyectos: state.proyectosSicla.length,
      empleados: state.empleadosActivos.length,
    });
  }

  //#11 leer factura completa
  // trae todos los campos necesarios desde inv.invoice_documents
  async function fetchFacturaCompletaById(facturaId) {
    const supabase = getSupabase();

    log("cargando factura completa:", facturaId);

    const { data, error } = await supabase
      .schema("inv")
      .from("invoice_documents")
      .select(`
        id,
        document_number,
        document_type,
        issue_date,
        supplier_name,
        supplier_id,
        sender_email,
        currency_code,
        exchange_rate,
        amount_crc,
        amount_usd,
        amount_original,
        internal_status,
        processing_status,
        client_name,
        project_code,
        project_name,
        assigned_to,
        comments,
        capa,
        needs_assignment,
        has_pdf,
        has_missing_xml,
        google_drive_url,
        google_drive_file_id,
        pdf_file_name,
        xml_fac_url,
        xml_rhm_url,
        liq_assigned_to,
        liq_type,
        liq_status,
        liq_created_at,
        liq_updated_at,
        liq_closed_at,
        liq_comments,
        created_at,
        updated_at
      `)
      .eq("id", facturaId)
      .maybeSingle();

    if (error) {
      logError("error cargando factura completa:", error);
      throw error;
    }

    if (!data) {
      throw new Error("La factura no existe o no está disponible.");
    }

    return data;
  }

  //#12 referencias de proyecto actual
  // resuelve el proyecto actual desde el catálogo por código exacto
  function getCurrentProject() {
    if (!state.facturaActual) return null;

    return (
      state.proyectosSicla.find(
        (item) =>
          String(item.project_code || "").trim() ===
          String(state.facturaActual.project_code || "").trim()
      ) || null
    );
  }

  //#13 resumen actual
  // refresca la segunda tarjeta con datos actuales del cliente/proyecto/capa
  function updateCurrentInfo() {
    const els = getEls();
    const factura = state.facturaActual;
    if (!els || !factura) return;

    const currentProject = getCurrentProject();

    els.clienteActual.textContent =
      String(factura.client_name || "").trim() || "Sin cliente asignado";

    els.proyectoCode.textContent =
      String(factura.project_code || "").trim() || "—";

    els.proyectoName.textContent =
      String(factura.project_name || "").trim() || "Sin proyecto";

    els.proyectoStatus.textContent =
      String(currentProject?.project_status || "").trim() || "Sin estado";

    els.capaActual.textContent =
      String(factura.capa || "").trim() || "Sin capa asignada";
  }

  //#14 selects del modal
  // llena capa, tipo y responsable usando el estado actual
  function populateSelects(factura) {
    const els = getEls();
    if (!els) return;

    els.capaSelect.innerHTML = `
      <option value="">Seleccionar capa</option>
      ${OPCIONES_CAPA.map((op) => `<option value="${escapeHtml(op)}">${escapeHtml(op)}</option>`).join("")}
    `;

    els.tipoSelect.innerHTML = `
      <option value="">Seleccionar tipo</option>
      ${OPCIONES_LIQ_TYPE.map((op) => `<option value="${escapeHtml(op)}">${escapeHtml(op)}</option>`).join("")}
    `;

    els.responsableSelect.innerHTML =
      state.empleadosActivos.length > 0
        ? state.empleadosActivos
            .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
            .join("")
        : `<option value="">Sin responsable</option>`;

    els.capaSelect.value = String(factura?.capa || "").trim();
    els.tipoSelect.value = String(factura?.liq_type || "").trim();

    const responsableInicial =
      String(factura?.liq_assigned_to || "").trim() || getEmployeeName() || "";

    els.responsableSelect.value = responsableInicial;

    if (els.responsableSelect.value !== responsableInicial && responsableInicial) {
      const opt = document.createElement("option");
      opt.value = responsableInicial;
      opt.textContent = responsableInicial;
      els.responsableSelect.appendChild(opt);
      els.responsableSelect.value = responsableInicial;
    }

    els.estadoInput.value = resolveLiquidacionEstadoVisible(factura);
    els.comentarioInput.value = String(factura?.liq_comments || "").trim();
  }

  //#15 dropdown clientes
  // muestra clientes únicos filtrados desde SICLA
  function hideClienteDropdown() {
    const els = getEls();
    if (!els) return;
    els.clienteDrop.style.display = "none";
  }

  function renderClienteDropdown() {
    const els = getEls();
    if (!els || !state.facturaActual) return;

    const filtro = normalizeText(els.clienteInput.value);

    const unicos = Array.from(
      new Set(
        state.proyectosSicla
          .map((item) => String(item.client_name || "").trim())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b, "es"));

    const visibles = !filtro
      ? unicos.slice(0, 20)
      : unicos.filter((item) => item.toLowerCase().includes(filtro)).slice(0, 20);

    if (!visibles.length) {
      els.clienteDrop.innerHTML = `<div class="facturasLiqComboEmpty">No hay clientes que coincidan.</div>`;
    } else {
      els.clienteDrop.innerHTML = visibles
        .map(
          (cliente) => `
            <button type="button" class="facturasLiqComboOption" data-cliente="${escapeHtml(cliente)}">
              <span class="facturasLiqComboMain">${escapeHtml(cliente)}</span>
            </button>
          `
        )
        .join("");
    }

    els.clienteDrop.style.display = "";

    els.clienteDrop.querySelectorAll("[data-cliente]").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", () => {
        const value = String(btn.getAttribute("data-cliente") || "").trim();

        els.clienteInput.value = value;
        state.facturaActual.client_name = value;
        state.facturaActual._clienteSeleccionadoExacto = value;

        const proyectoActualCode = String(state.facturaActual.project_code || "").trim();

        const proyectoSigue = state.proyectosSicla.some(
          (item) =>
            String(item.client_name || "").trim() === value &&
            String(item.project_code || "").trim() === proyectoActualCode
        );

        if (!proyectoSigue) {
          state.facturaActual.project_code = "";
          state.facturaActual.project_name = "";
          els.proyectoInput.value = "";
        }

        updateCurrentInfo();
        hideClienteDropdown();
      });
    });
  }

  //#16 dropdown proyectos
  // muestra proyectos por cliente y búsqueda actual
  function hideProyectoDropdown() {
    const els = getEls();
    if (!els) return;
    els.proyectoDrop.style.display = "none";
  }

  function renderProyectoDropdown() {
    const els = getEls();
    if (!els || !state.facturaActual) return;

    const filtro = normalizeText(els.proyectoInput.value);
    const cliente = String(state.facturaActual.client_name || "").trim();

    let base = [...state.proyectosSicla];

    if (cliente) {
      base = base.filter(
        (item) => String(item.client_name || "").trim() === cliente
      );
    }

    const visibles = !filtro
      ? base.slice(0, 20)
      : base
          .filter((item) => {
            const code = normalizeText(item.project_code);
            const name = normalizeText(item.name);
            const clientName = normalizeText(item.client_name);
            const status = normalizeText(item.project_status);

            return (
              code.includes(filtro) ||
              name.includes(filtro) ||
              clientName.includes(filtro) ||
              status.includes(filtro)
            );
          })
          .slice(0, 20);

    if (!visibles.length) {
      els.proyectoDrop.innerHTML = `<div class="facturasLiqComboEmpty">No hay proyectos que coincidan.</div>`;
    } else {
      els.proyectoDrop.innerHTML = visibles
        .map(
          (item) => `
            <button
              type="button"
              class="facturasLiqComboOption"
              data-code="${escapeHtml(item.project_code)}"
            >
              <span class="facturasLiqComboMain">${escapeHtml(item.project_code)} · ${escapeHtml(item.name || "")}</span>
              ${item.client_name ? `<span class="facturasLiqComboSub">${escapeHtml(item.client_name)}</span>` : ""}
              ${item.project_status ? `<span class="facturasLiqComboMuted">Estado SICLA: ${escapeHtml(item.project_status)}</span>` : ""}
            </button>
          `
        )
        .join("");
    }

    els.proyectoDrop.style.display = "";

    els.proyectoDrop.querySelectorAll("[data-code]").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", () => {
        const code = String(btn.getAttribute("data-code") || "").trim();

        const project = state.proyectosSicla.find(
          (item) => String(item.project_code || "").trim() === code
        );

        if (!project) return;

        state.facturaActual.project_code = String(project.project_code || "").trim();
        state.facturaActual.project_name = String(project.name || "").trim();
        state.facturaActual.client_name =
          String(project.client_name || "").trim() ||
          String(state.facturaActual.client_name || "").trim();

        state.facturaActual._clienteSeleccionadoExacto = String(
          state.facturaActual.client_name || ""
        ).trim();

        els.proyectoInput.value = buildProjectText(project);
        els.clienteInput.value = String(state.facturaActual.client_name || "").trim();

        updateCurrentInfo();
        hideProyectoDropdown();
      });
    });
  }

  //#17 eventos del modal
  // amarra listeners una sola vez
  function bindEvents() {
    const els = getEls();
    if (!els) return;
    if (els.modal.dataset.bound === "1") return;

    els.modal.dataset.bound = "1";

    els.pdfBtn.addEventListener("click", () => {
      if (!state.facturaActual) return;
      openPdfFromLiquidacion();
    });

    els.clearClienteBtn.addEventListener("click", () => {
      if (!state.facturaActual) return;

      els.clienteInput.value = "";
      state.facturaActual.client_name = "";
      state.facturaActual._clienteSeleccionadoExacto = "";
      state.facturaActual.project_code = "";
      state.facturaActual.project_name = "";
      els.proyectoInput.value = "";

      renderClienteDropdown();
      updateCurrentInfo();
    });

    els.clearProyectoBtn.addEventListener("click", () => {
      if (!state.facturaActual) return;

      els.proyectoInput.value = "";
      state.facturaActual.project_code = "";
      state.facturaActual.project_name = "";

      renderProyectoDropdown();
      updateCurrentInfo();
    });

    els.clienteInput.addEventListener("input", () => {
      if (!state.facturaActual) return;

      state.facturaActual.client_name = String(els.clienteInput.value || "").trim();

      if (
        normalizeText(els.clienteInput.value) !==
        normalizeText(state.facturaActual._clienteSeleccionadoExacto || "")
      ) {
        state.facturaActual.project_code = "";
        state.facturaActual.project_name = "";
        els.proyectoInput.value = "";
      }

      renderClienteDropdown();
      updateCurrentInfo();
    });

    els.clienteInput.addEventListener("focus", () => {
      renderClienteDropdown();
    });

    els.clienteInput.addEventListener("blur", () => {
      setTimeout(hideClienteDropdown, 120);
    });

    els.proyectoInput.addEventListener("input", () => {
      if (!state.facturaActual) return;

      const typed = String(els.proyectoInput.value || "").trim();
      const currentText = buildProjectText({
        project_code: state.facturaActual.project_code,
        name: state.facturaActual.project_name,
      });

      if (typed !== currentText) {
        state.facturaActual.project_code = "";
        state.facturaActual.project_name = "";
      }

      renderProyectoDropdown();
      updateCurrentInfo();
    });

    els.proyectoInput.addEventListener("focus", () => {
      renderProyectoDropdown();
    });

    els.proyectoInput.addEventListener("blur", () => {
      setTimeout(hideProyectoDropdown, 120);
    });

    els.capaSelect.addEventListener("change", () => {
      if (!state.facturaActual) return;
      state.facturaActual.capa = String(els.capaSelect.value || "").trim();
      updateCurrentInfo();
    });

    els.guardarBtn.addEventListener("click", async () => {
      await save();
    });
  }

  //#18 llenar modal
  // coloca los valores actuales de la factura en la UI
  function fill(factura) {
    const els = getEls();
    if (!els) return;

    const estadoVisible = resolveLiquidacionEstadoVisible(factura);
    const monto = resolveDisplayAmount(factura);

    els.docSmall.textContent =
      String(factura.document_number || "").trim() || "Sin número";

    els.docBig.textContent =
      String(factura.document_number || "").trim() || "Sin consecutivo";

    els.fecha.textContent = formatIssueDate(factura.issue_date);
    els.proveedor.textContent = formatSupplierLabel(factura);
    els.monto.textContent = formatMoney(monto.currency, monto.amount);
    els.estadoVisible.textContent = estadoVisible;
    els.estadoInput.value = estadoVisible;

    els.clienteInput.value = String(factura.client_name || "").trim();
    els.proyectoInput.value = buildProjectText({
      project_code: factura.project_code,
      name: factura.project_name,
    });

    populateSelects(factura);
    updateCurrentInfo();

    els.pdfBtn.disabled = !resolvePdfInfo(factura).hasPdf;
    els.guardarBtn.disabled = false;
    els.guardarBtn.textContent = "Guardar liquidación";
  }

  //#19 validación
  // valida datos mínimos obligatorios antes del update
  function validate() {
    const els = getEls();
    if (!els || !state.facturaActual) return "No se encontró la factura a guardar.";

    const clientName = String(els.clienteInput.value || "").trim();
    const projectCode = String(state.facturaActual.project_code || "").trim();
    const tipo = String(els.tipoSelect.value || "").trim();
    const capa = String(els.capaSelect.value || "").trim();
    const responsable = String(els.responsableSelect.value || "").trim();

    if (!clientName) return "Selecciona un cliente antes de guardar.";
    if (!projectCode) return "Selecciona un proyecto válido antes de guardar.";
    if (!tipo) return "Selecciona el tipo de liquidación.";
    if (!capa) return "Selecciona la capa antes de guardar.";
    if (!responsable) return "No se encontró un responsable válido para guardar.";

    const currentProject = state.proyectosSicla.find(
      (item) => String(item.project_code || "").trim() === projectCode
    );

    if (!currentProject) {
      return "El proyecto seleccionado no existe en el catálogo SICLA disponible.";
    }

    return "";
  }

  //#20 guardar
  // actualiza inv.invoice_documents y notifica al módulo padre
  async function save() {
    if (state.guardando) return;

    const supabase = getSupabase();
    const els = getEls();
    const factura = state.facturaActual;

    if (!els || !factura?.id) {
      setMessage("error", "No se pudo preparar el guardado de la factura.");
      return;
    }

    const validationError = validate();
    if (validationError) {
      setMessage("error", validationError);
      return;
    }

    const project = state.proyectosSicla.find(
      (item) =>
        String(item.project_code || "").trim() ===
        String(factura.project_code || "").trim()
    );

    const clientName = String(els.clienteInput.value || "").trim();
    const tipo = String(els.tipoSelect.value || "").trim();
    const capa = String(els.capaSelect.value || "").trim();
    const responsable = String(els.responsableSelect.value || "").trim();
    const comentario = String(els.comentarioInput.value || "").trim();

    const ahora = new Date().toISOString();
    const estadoActual = String(factura?.liq_status || "").trim();

    const estadoAutomatico =
      !estadoActual ||
      normalizeText(estadoActual) === "pendiente" ||
      normalizeText(estadoActual) === "revision"
        ? "Reclamada"
        : estadoActual;

    const payload = {
      client_name: clientName,
      project_code: String(project?.project_code || "").trim(),
      project_name: String(project?.name || "").trim() || null,
      capa: capa || null,
      liq_assigned_to: responsable || null,
      liq_type: tipo,
      liq_status: estadoAutomatico,
      liq_comments: comentario || null,
      liq_updated_at: ahora,
      updated_at: ahora,
    };

    if (!factura?.liq_created_at) {
      payload.liq_created_at = ahora;
    }

    log("guardando liquidación:", {
      facturaId: factura.id,
      payload,
    });

    try {
      state.guardando = true;
      els.guardarBtn.disabled = true;
      els.guardarBtn.textContent = "Guardando...";
      setMessage("info", "Guardando liquidación...");

      const { data, error } = await supabase
        .schema("inv")
        .from("invoice_documents")
        .update(payload)
        .eq("id", factura.id)
        .select(`
          id,
          issue_date,
          document_number,
          document_type,
          supplier_name,
          currency_code,
          amount_crc,
          amount_usd,
          amount_original,
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
          liq_created_at,
          liq_updated_at,
          created_at,
          updated_at
        `)
        .maybeSingle();

      if (error) {
        logError("error guardando liquidación:", error);
        throw error;
      }

      if (!data) {
        throw new Error("No se recibió la factura actualizada después del guardado.");
      }

      state.facturaActual = {
        ...state.facturaActual,
        ...data,
        _clienteSeleccionadoExacto: String(data.client_name || "").trim(),
      };

      fill(state.facturaActual);
      setMessage("ok", "Liquidación guardada correctamente.");

      if (typeof onAfterSave === "function") {
        await onAfterSave(state.facturaActual);
      }

      setTimeout(() => {
        close();
      }, 700);
    } catch (err) {
      logError("save catch:", err);
      setMessage("error", mapHumanLiquidacionError(err));
    } finally {
      state.guardando = false;
      if (els?.guardarBtn) {
        els.guardarBtn.disabled = false;
        els.guardarBtn.textContent = "Guardar liquidación";
      }
    }
  }

  //#21 API pública open
  // abre el modal cargando catálogos y factura completa por id
  async function open(facturaBase) {
    const facturaId = String(facturaBase?.id || "").trim();
    if (!facturaId) return;

    log("open:", {
      facturaId,
      document_number: facturaBase?.document_number,
    });

    try {
      ensureModal();
      bindEvents();
      setMessage("info", "Cargando información...");

      const modal = document.getElementById(LIQ_MODAL_ID);
      modal.style.display = "flex";
      modal.style.visibility = "";
      modal.style.pointerEvents = "";
      modal.removeAttribute("data-hidden-for-pdf");
      document.body.style.overflow = "hidden";

      state.modalOpen = true;
      state.guardando = false;
      state.hiddenForPdf = false;
      state.facturaActual = null;

      await ensureCatalogs();
      const facturaCompleta = await fetchFacturaCompletaById(facturaId);

      state.facturaActual = {
        ...facturaCompleta,
        _clienteSeleccionadoExacto: String(facturaCompleta.client_name || "").trim(),
      };

      fill(state.facturaActual);
      setMessage("", "");
    } catch (err) {
      logError("error abriendo modal:", err);
      setMessage(
        "error",
        err?.message || "No se pudo abrir la liquidación."
      );
    }
  }

  //#22 API pública close
  // cierra el modal y limpia estado temporal
  function close() {
    const modal = document.getElementById(LIQ_MODAL_ID);
    if (!modal) return;

    hideClienteDropdown();
    hideProyectoDropdown();

    modal.style.display = "none";
    modal.style.visibility = "";
    modal.style.pointerEvents = "";
    modal.removeAttribute("data-hidden-for-pdf");

    state.modalOpen = false;
    state.facturaActual = null;
    state.guardando = false;
    state.hiddenForPdf = false;

    document.body.style.overflow = "";
  }

  //#23 API pública ensure
  // deja el modal creado y listo sin abrirlo
  function ensure() {
    ensureModal();
    bindEvents();
    log("modal inicializado");
    return true;
  }

  //#24 exports del controlador
  // expone solo lo necesario al archivo orquestador
  return {
    ensure,
    open,
    close,
    isOpen: () => state.modalOpen,
    isSaving: () => state.guardando,
  };
}
// API mock en Node/Express.
// Objetivo: permitir probar el frontend HOY con el mismo contrato que tendrá
// la API .NET definitiva (ExecutionResponse<T>, rutas api/<Schema>/<Accion>).
// Cuando se construya la API .NET real, solo se cambia VITE_API_URL en el
// frontend: no hay que tocar ni un componente de React.

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const VISITAS_FILE = path.join(DATA_DIR, "visitas.json");

const app = express();
app.use(cors());
app.use(express.json({ limit: "35mb" })); // fotos van en base64 en este mock (hasta 5 por visita)

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
if (!fs.existsSync(VISITAS_FILE)) writeJson(VISITAS_FILE, []);

// Envoltorio estándar ExecutionResponse<T>
function ok(res, data, msg = "Operación exitosa") {
  res.json({ Data: data, Success: true, SuccessMessage: msg, ErrorMessage: "" });
}
function fail(res, msg, status = 400) {
  res.status(status).json({ Data: null, Success: false, SuccessMessage: "", ErrorMessage: msg });
}

// ---------- Schema: Clientes ----------
app.get("/api/Clientes/Todos", (req, res) => {
  const clientes = readJson(path.join(DATA_DIR, "clientes.json"), []);
  ok(res, clientes);
});

// Catálogo de empresas/región. En producción esto se trae del cubo con
// [DimClientes].[CodEmpresa].MEMBERS en el catálogo SSAS_OnePageComercial
// (confirmado contra el cubo real: imcr, imgt, imhn, imsl son los 4 miembros
// reales de esa dimensión).
app.get("/api/Clientes/Empresas", (req, res) => {
  ok(res, ["IMGT", "IMHN", "IMSL", "IMCR"]);
});

// Simula lo que en producción vendría del cubo OLAP (ReporteOperativoComercial /
// SSAS_OnePageComercial) vía el proxy IMCore: pedido últimos 30 días, para el
// código de cliente indicado.
// NOTA: las devoluciones NO se traen del cubo. Hoy no existe un cubo confiable
// con devoluciones pendientes de procesar, así que ese criterio se evalúa
// manualmente en campo (ver plantilla.json, c11 ya no tiene FuenteAutomatica).
app.get("/api/Clientes/IndicadoresCubo/:codigo", (req, res) => {
  const seed = req.params.codigo.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const tienePedidoReciente = seed % 3 !== 0;
  ok(res, {
    CodigoCliente: req.params.codigo,
    TienePedidoUltimos30Dias: tienePedidoReciente,
    Fuente: "MOCK - en producción viene de POST /api/Cubo/Mdx (ver GUIA_CUBO_MDX.md)"
  });
});

// ---------- Schema: Plantillas ----------
app.get("/api/Plantillas/Activa", (req, res) => {
  const plantilla = readJson(path.join(DATA_DIR, "plantilla.json"), null);
  if (!plantilla) return fail(res, "No hay plantilla activa configurada", 404);
  ok(res, plantilla);
});

// Guarda la plantilla completa (agregar/quitar criterios, cambiar pesos).
// Es una sola plantilla "viva": no se versiona, las visitas ya guardadas
// conservan una copia de PlantillaId pero no de los criterios usados.
app.put("/api/Plantillas/Activa", (req, res) => {
  const nueva = req.body;
  if (!nueva || !Array.isArray(nueva.Criterios) || nueva.Criterios.length === 0) {
    return fail(res, "La plantilla debe tener al menos un criterio");
  }
  for (const c of nueva.Criterios) {
    if (!c.Id || !c.Texto || typeof c.Peso !== "number") {
      return fail(res, "Cada criterio necesita Id, Texto y Peso numérico");
    }
  }
  const sumaPesos = nueva.Criterios.reduce((a, c) => a + c.Peso, 0);
  if (Math.round(sumaPesos * 1000) / 1000 !== 1) {
    return fail(res, `La suma de los pesos debe dar 100% (hoy da ${(sumaPesos * 100).toFixed(1)}%)`);
  }

  const actual = readJson(path.join(DATA_DIR, "plantilla.json"), {});
  const guardada = {
    ...actual,
    Nombre: nueva.Nombre || actual.Nombre,
    MinFotos: nueva.MinFotos ?? actual.MinFotos ?? 3,
    MaxFotos: nueva.MaxFotos ?? actual.MaxFotos ?? 5,
    Criterios: nueva.Criterios,
  };
  writeJson(path.join(DATA_DIR, "plantilla.json"), guardada);
  ok(res, guardada, "Plantilla actualizada correctamente");
});

// ---------- Schema: Visitas ----------
app.get("/api/Visitas/Todos", (req, res) => {
  const visitas = readJson(VISITAS_FILE, []);
  ok(res, visitas.sort((a, b) => new Date(b.Fecha) - new Date(a.Fecha)));
});

app.get("/api/Visitas/PorCliente/:codigo", (req, res) => {
  const visitas = readJson(VISITAS_FILE, []);
  const filtradas = visitas
    .filter((v) => v.CodigoCliente === req.params.codigo)
    .sort((a, b) => new Date(b.Fecha) - new Date(a.Fecha));
  ok(res, filtradas);
});

app.post("/api/Visitas/Guardar", (req, res) => {
  const body = req.body;
  if (!body.CodigoCliente || !body.Asesor || !Array.isArray(body.Respuestas)) {
    return fail(res, "Faltan campos requeridos (CodigoCliente, Asesor, Respuestas)");
  }

  const plantilla = readJson(path.join(DATA_DIR, "plantilla.json"), { Criterios: [], MinFotos: 3 });
  const minFotos = plantilla.MinFotos ?? 3;
  if (!Array.isArray(body.Fotos) || body.Fotos.length < minFotos) {
    return fail(res, `Se requieren al menos ${minFotos} fotografías de evidencia`);
  }

  const pesos = Object.fromEntries(plantilla.Criterios.map((c) => [c.Id, c.Peso]));

  // Cumple: true | false | null (null = "No aplica", se excluye del cálculo)
  let notaAcumulada = 0;
  let baseAplicable = 0;
  for (const r of body.Respuestas) {
    const peso = pesos[r.CriterioId] ?? 0;
    if (r.Cumple === null) continue; // No aplica: no suma ni resta
    baseAplicable += peso;
    if (r.Cumple === true) notaAcumulada += peso;
  }
  const nota = baseAplicable > 0 ? notaAcumulada / baseAplicable : 0;

  const visita = {
    Id: crypto.randomUUID(),
    Fecha: body.Fecha || new Date().toISOString(),
    Asesor: body.Asesor,
    CodigoCliente: body.CodigoCliente,
    Cliente: body.Cliente,
    Pais: body.Pais,
    Empresa: body.Empresa,
    Geolocalizacion: body.Geolocalizacion || null,
    PlantillaId: plantilla.Id,
    Respuestas: body.Respuestas,
    Fotos: body.Fotos,
    NotaFinal: Math.round(nota * 10000) / 10000,
  };

  const visitas = readJson(VISITAS_FILE, []);
  visitas.push(visita);
  writeJson(VISITAS_FILE, visitas);

  ok(res, visita, "Visita guardada correctamente");
});

app.delete("/api/Visitas/:id", (req, res) => {
  const visitas = readJson(VISITAS_FILE, []);
  const restantes = visitas.filter((v) => v.Id !== req.params.id);
  writeJson(VISITAS_FILE, restantes);
  ok(res, null, "Visita eliminada");
});

const PORT = process.env.PORT || 5028;
app.listen(PORT, () => {
  console.log(`Tienda Perfecta API (mock) escuchando en http://localhost:${PORT}`);
});

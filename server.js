import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const sensors = [
  { sensorId: "study",  name: "Estudio" },
  { sensorId: "living", name: "Salón" },
  { sensorId: "bed",    name: "Dormitorio" },
  { sensorId: "hall",   name: "Pasillo" }
];

app.get("/api/health", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get("/api/sensors/latest", (req, res) => {
  const now = new Date().toISOString();
  const out = sensors.map(s => ({
    sensorId: s.sensorId,
    name: s.name,
    temp: +(20 + Math.random() * 4 - 2).toFixed(1),
    rh: +(45 + Math.random() * 20).toFixed(0),
    ts: now
  }));
  res.json(out);
});

const PORT = 8787;
app.listen(PORT, () => {
  console.log(`SYNLIVE server running on http://localhost:${PORT}`);
});

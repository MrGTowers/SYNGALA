# SYNGALA — Digital Twin Viewer (WIP)

Visor 3D experimental de edificios orientado a monitorización energética, confort y operación por espacios. **Proyecto en desarrollo; no utilizar para control de instalaciones críticas.**

## Funcionalidades actuales

- Importación de geometría desde gbXML y navegación/selección de espacios.
- Sensores históricos CSV: asignación a espacios, temperatura y humedad, gráficos y filtros temporales.
- SYNLIVE: lectura periódica de un servidor de prueba con sensores simulados y actualización de gráficos y estados.
- Consignas de temperatura día/noche (setback), tolerancias y umbrales de humedad por espacio.
- Coloreado de habitaciones según estados de confort y marcadores de sensores; identificación LIVE.
- Guardado y carga de proyectos `.syngala.json` (implementación experimental).
- Tipologías de espacio y controles de visor.

## Estructura

```text
modeller.html                Visor web
js/modeller.js              Lógica 3D, telemetría y proyectos
synlive_server/server.js    Fuente LIVE simulada (no SwitchBot real)
synlive_server/package.json Dependencias del servidor de prueba
README.md                   Documentación
TODO.md                     Pendientes
.gitignore                  Exclusiones para Git
```

## Puesta en marcha

Requisitos: Node.js y un navegador moderno. Python es opcional para servir el frontend.

**Terminal 1 — sensores LIVE de demostración:**

```bash
cd synlive_server
npm install
npm start
```

Comprobar `http://localhost:8787/api/sensors/latest`.

**Terminal 2 — visor:** desde la raíz del repositorio:

```bash
python -m http.server 5500
```

Abrir `http://localhost:5500/modeller.html`. Si no tienes Python, puedes usar Live Server en VS Code.

En el visor, importar tu propio gbXML, activar SYNLIVE, introducir `http://localhost:8787`, probar conexión y asignar sensores detectados a espacios. El servidor genera **datos ficticios**, no lecturas reales de tu vivienda.

**Nota:** las bibliotecas gráficas se cargan desde CDN y requieren acceso a Internet.

## Guardar / cargar

El formato `.syngala.json` puede incluir el modelo gbXML, configuraciones y series de sensores. Evita subir a GitHub archivos de proyecto con datos privados de edificios, ubicaciones o mediciones. El archivo se excluye en `.gitignore`.

## Estado y limitaciones

Este repositorio es una **instantánea de desarrollo** basada en el último paquete de trabajo. No se han realizado pruebas end-to-end en un navegador en esta entrega. El módulo de incidencias necesita validación de su integración visual: la lógica `updateDtAlertsPanel()` está presente en JS, pero el HTML de origen no contenía el contenedor `#dtAlertsPanel`; se ha añadido el contenedor sin alterar la lógica existente. Ver `TODO.md`.

El backend SYNLIVE es un mock local. No hay persistencia de histórico LIVE en base de datos ni integración SwitchBot real. Las alarmas son indicativas, no un sistema de seguridad certificado.

## Próximos pasos

Consultar [TODO.md](TODO.md) para el plan de estabilización, tests, persistencia e integración de sensores reales.

## Publicar en GitHub

Crear un repositorio vacío en GitHub y ejecutar desde la raíz:

```bash
git init
git add .
git commit -m "Initial WIP digital twin viewer"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/TU-REPOSITORIO.git
git push -u origin main
```

Reemplaza `TU-USUARIO/TU-REPOSITORIO` por los tuyos. No publiques claves API ni datos privados.

## Licencia

Licencia pendiente de definir por el autor. No se incluye licencia de reutilización del código propio.

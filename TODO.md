# Pendientes de desarrollo

## Prioridad alta — estabilización

- [ ] Probar importación gbXML, selección, popover, asignación CSV y LIVE en navegador.
- [ ] Verificar que el panel de alertas aparece y que al pulsar una incidencia enfoca el espacio correcto.
- [ ] Revisar que `#dtAlertsPanel` se actualiza al importar CSV, cambiar setpoints y recibir LIVE.
- [ ] Verificar que los colores y los marcadores se refrescan al llegar cada lectura LIVE, sin pulsar Escape.
- [ ] Probar guardado y restauración de proyectos con tipologías, setpoints, series, asignaciones y configuración LIVE.
- [ ] Revisar que la carga no duplique sensores ni intervalos de polling.
- [ ] Corregir cualquier error de consola y añadir pruebas de regresión para no romper versiones estables.

## Evolución

- [ ] Sustituir backend mock por conector SwitchBot real, manteniendo credenciales fuera del frontend.
- [ ] Persistir series LIVE en base de datos y permitir consultar periodos anteriores.
- [ ] Diferenciar claramente alertas de confort de alertas por sensor desconectado.
- [ ] Añadir panel global de KPIs y tiempos fuera de consigna.
- [ ] Mejorar adaptación responsive y accesibilidad del visor.
- [ ] Separar código monolítico en módulos y documentar el esquema `.syngala.json`.
- [ ] Añadir tests automatizados y pipeline CI.
- [ ] Definir licencia y estrategia de despliegue seguro.

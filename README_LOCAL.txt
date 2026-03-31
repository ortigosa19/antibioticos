USO LOCAL (Windows)
===================

1) Doble clic en INICIAR.bat
   - La primera vez instalará dependencias automáticamente.
   - Abrirá el navegador en: http://localhost:8080

2) Base de datos
   - La BD está en: backend\db\local.db
   - Cada arranque crea un backup en: backend\backup\
   - Para desactivar backup: en backend\.env pon:
       LOCAL_DB_BACKUP=0

3) Parar el programa
   - Cierra la ventana del servidor (la que abre INICIAR.bat).

Notas
-----
- Este proyecto está preparado SOLO para uso local.
- No incluye node_modules para que el ZIP sea ligero (se instala al iniciar).

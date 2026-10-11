# Almacén (PWA de inventario)

Aplicación web instalable que funciona sin conexión. Los datos viven en **IndexedDB de cada teléfono**; GitHub Pages solo sirve los archivos de la app, **no guarda tu inventario**. Haz copias de seguridad.

## Archivos (todos en la raíz, sin carpetas)
index.html, styles.css, app.js, database.js, inventory.js, categories.js, gallery.js, lists.js, settings.js, **sync.js**, manifest.json, service-worker.js, icon-192.png, icon-512.png, README.md

## Publicar en GitHub Pages desde el teléfono
1. Crea el repositorio y sube cada archivo a la raíz (Add file › Upload files).
2. Settings › Pages › Deploy from a branch › `main` / `(root)`.
3. Abre la dirección `https://usuario.github.io/repositorio/` en Chrome › menú › «Instalar aplicación».
4. **No subas** `inventario-inicial.json` al repositorio (tiene tus cantidades): pásalo directo al teléfono.

## Cargar el inventario inicial
Configuración › Copias de seguridad › «Restaurar una copia…» › elige `inventario-inicial.json` › Reemplazar todo.

## Actualizar a la app nueva
Al subir cambios, edita `VERSION` en `service-worker.js`. En el teléfono: Configuración › «Buscar actualización de la aplicación».

## Actualización de inventario entre dos teléfonos
**Teléfono del administrador:** Configuración › Actualización entre teléfonos › «Crear archivo de actualización…» › elige fotos › «Compartir…» (WhatsApp) o «Descargar».
**Teléfono del otro usuario:** abre el archivo recibido (si WhatsApp lo muestra como `.txt` funciona igual) › Configuración › «Aplicar un archivo de actualización…» › revisa el resumen › Aplicar.
- Cada producto/categoría se reconoce por un identificador interno estable: no se duplican aunque cambie nombre, código o color.
- Se actualizan: categorías, datos del producto, descripción, presentación, cantidades y precios (cantidades y precios se pueden excluir).
- Cantidad cambiada → queda un «Ajuste» en el historial del otro teléfono.
- Productos que el administrador eliminó → se **archivan** (no se borran).
- No se tocan: ajustes, apariencia, listados, historial propio ni productos que solo existan en ese teléfono.
- Todo se aplica en una sola operación (si falla, no cambia nada) y se ofrece copia de seguridad previa.
- Las fotos solo viajan si eliges incluirlas. La primera vez conviene «Todas las fotos».
- Si ese teléfono se preparó restaurando una copia del administrador, en la primera actualización aparece la opción «Archivar lo que el administrador ya no tiene».

## Menú por categorías y carritos
- **Almacén** abre con botones de categorías → subcategorías → productos (como un menú digital). El buscador sigue funcionando en cualquier nivel; «Todos los productos» muestra la lista completa.
- Arriba hay tres modos: **Consultar**, **Salida** y **Entrada**. En Salida/Entrada cada producto muestra −, un campo de cantidad editable y botones rápidos (+5, +10, +12, +50…). Se cambian en Configuración › «Botones rápidos del carrito».
- Abajo aparece la barra del carrito: «Ver y confirmar» pide el **cliente** (o proveedor), una nota, y registra **todo el pedido en una sola operación** (si algo falla, no cambia nada; una doble pulsación no lo duplica). Al terminar puedes compartir el resumen.
- En **Movimientos** busca por el nombre del cliente; al abrir un movimiento verás el pedido completo.
- En una salida no se puede pasar de la existencia (salvo que lo permitas en Configuración). Los productos sin existencia registrada necesitan un Ajuste antes.

## Recibos y totales
- En la salida, cada producto del carrito muestra su precio (el del producto, subcategoría o categoría) y puedes cambiarlo solo para ese pedido. El carrito suma el **total**; los productos sin precio no se incluyen y se avisa.
- Al confirmar: «Compartir recibo (imagen)» (letra grande, se ve completa en WhatsApp), «Compartir como texto» (cada producto en 2 líneas cortas) o archivo .txt. Se puede ocultar los precios.
- El generador de listados también tiene «Como imagen».

## Notas
- Cantidad vacía = «sin registrar» (no es 0). Las cantidades aproximadas se marcan con ≈ y no se mezclan con las confirmadas.
- No genera APK. Es una PWA instalable desde Chrome.

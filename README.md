# Almacén (PWA de inventario)

Aplicación web instalable que funciona sin conexión. Los datos viven en **IndexedDB de cada teléfono**; GitHub Pages solo sirve los archivos de la app, **no guarda tu inventario**. Haz copias de seguridad.

## Archivos (todos en la raíz, sin carpetas)
index.html, styles.css, app.js, database.js, inventory.js, categories.js, gallery.js, lists.js, settings.js, sync.js, **cart.js, shareimg.js**, manifest.json, service-worker.js, icon-192.png, icon-512.png, README.md

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

## Bajas, pérdidas y retiros (v1.4.0)
- En el carrito elige el modo **Baja** (o el botón «Baja: pérdida o retiro» en la ficha de un producto). Motivos: Pérdida, Producto dañado, Retiro de mercancía y los que añadas en Configuración. **No es una venta ni un ingreso.**
- Descuentan la existencia y quedan en Movimientos › **Bajas**, con quién retiró, fecha y un resumen de totales por producto y motivo.
- Si la cantidad es desconocida o insuficiente, la app no inventa nada: registra la baja como **discrepancia** (no toca la existencia) y aparece en Movimientos › **⚠ Discrep.** hasta que la marques como revisada.

## Compartir como imágenes (v1.4.0)
- En «Generar un listado» (o los botones «Compartir…» del menú) elige categoría o todo el inventario, con o sin cantidades/precios, y pulsa «Compartir imágenes».
- Salen varias imágenes numeradas (1080 px de ancho, una o varias por categoría, p. ej. «Tintes capilares 3/9»), todas a la vez al menú de compartir de Android. Así no se pixelan ni se cortan.

## Actualizar el catálogo desde un archivo
`actualizacion-catalogo.json` NO se sube a GitHub: se aplica en Configuración › Actualización entre teléfonos › «Aplicar un archivo de actualización». Muestra una vista previa (cantidades, precios, productos nuevos, retiros) antes de cambiar nada y no duplica si se aplica dos veces.

## Cambiar precios por grupo o eligiendo productos (v1.4.2)
Configuración › «Precios por grupo»: agrupa los productos de la misma marca, presentación y tamaño (el color, el código y el volumen no cuentan; p. ej. todos los Stereo de 50 ml, o los peróxidos Oggy de 1 L en 30 y 40 vol). Escribes el precio y «Aplicar a todos». Si el grupo tenía precios distintos, pide confirmación. Cada grupo tiene «Elegir…» para marcar solo algunos productos (p. ej. dejar fuera los rojos), y el modo «Elegir productos» permite marcar productos sueltos de cualquier marca y ponerles un precio a la vez.

## Pedidos apartados y totales por categoría (v1.5.0)
- Modo **Apartar**: armas un pedido con el cliente y lo guardas. Sus productos **salen del almacén ya** (quedan reservados) pero el pedido **no se factura todavía**. En **Pedidos** puedes editarlo (sumar o restar: la diferencia se descuenta o se devuelve sola), **Facturar** (genera el recibo) o **Cancelar pedido** (todo vuelve al almacén). Si no hay existencia suficiente, no deja apartar. Los pedidos viajan en la copia de seguridad.
- Cambiar el **precio general** de una subcategoría/categoría ahora puede aplicarse a todos sus productos (casilla «Aplicarlo a todos los productos»).
- El recibo (imagen, texto y .txt) incluye **TOTAL POR CATEGORÍA** y, debajo, por subcategoría (p. ej. «Tintes capilares: 40 tubos» › «Stereo: 17 tubos»).

## Notas
- Cantidad vacía = «sin registrar» (no es 0). Las cantidades aproximadas se marcan con ≈ y no se mezclan con las confirmadas.
- No genera APK. Es una PWA instalable desde Chrome.

# El protocolo del AXT600: qué falta y cómo capturarlo

El plugin ya funciona de punta a punta con un AXT600 simulado. Lo único que no
sabe hacer es hablar con un AXT600 de verdad, porque Shure no publica el
protocolo de red del equipo. La forma de averiguarlo es observar cómo Wireless
Workbench habla con tu unidad y grabar ese tráfico con Wireshark.

Todo lo que se escriba a partir de las capturas va en una sola clase,
`Axt600NetworkLink` en `driver/link.js`. El adaptador, el ensamblado de
barridos y los tests no cambian.

## Lo que ya sabemos (por el datasheet)

| | |
|---|---|
| Rango | 470–952 MHz |
| Pasos de escaneo | 25 kHz, 200 kHz y 1 MHz |
| Tiempo máximo por 60 MHz | 48 s (25 kHz), 7 s (200 kHz), 1 s (1 MHz) |
| Rango completo a 25 kHz | 64 s, con 8 módulos de escaneo en paralelo |
| Antenas | 2 |
| Red | Ethernet 10/100, dos puertos, DHCP o IP manual |

## Lo que tienen que responder las capturas

1. **Descubrimiento.** ¿Cómo anuncia el AXT600 su presencia en la red? (¿SLP
   multicast como el AD600, broadcast, otro mecanismo?)
2. **Conexión.** ¿UDP o TCP, a qué puerto del equipo, y qué handshake hace
   Wireless Workbench antes de poder pedir un escaneo?
3. **Configurar un escaneo.** ¿Qué mensaje lleva el rango y el paso, y qué
   contesta el equipo?
4. **Datos del escaneo.** ¿Cómo llegan los niveles? (por antena, por bloques de
   cada módulo, en qué unidad y codificación)
5. **Exclusividad.** ¿Puede escanear para dos controladores a la vez, o hay que
   cerrar Wireless Workbench para que el plugin lo use?
6. **Mantener viva la sesión.** ¿Hay mensajes periódicos (keep-alive)?

## Cómo hacer las capturas

### Preparación

- Instala **Wireshark** (wireshark.org). En macOS, durante la instalación acepta
  el componente *ChmodBPF* para poder capturar sin ser administrador.
- Conecta el ordenador y el AXT600 al mismo switch, o con un cable directo.
- Anota la **IP** del AXT600 (panel frontal, menú de red) y su **versión de
  firmware**.
- Cierra cualquier otro programa que pueda hablar con equipos Shure.

### Captura 1: descubrimiento y conexión

1. Con Wireless Workbench **cerrado**, abre Wireshark y empieza a capturar en la
   interfaz de red conectada al AXT600 (Ethernet, no Wi‑Fi). Sin filtro de
   captura: queremos ver también el tráfico multicast.
2. Abre Wireless Workbench y espera a que aparezca el AXT600 en el inventario.
3. Espera un minuto sin tocar nada.
4. Para la captura y guárdala como `01-descubrimiento.pcapng`.

### Captura 2: un escaneo conocido

1. Empieza una captura nueva.
2. En Wireless Workbench lanza un escaneo con el AXT600 con **ajustes que
   anotes exactamente**, por ejemplo: 470–616 MHz, paso 200 kHz.
3. Deja que termine un par de pasadas completas.
4. Para el escaneo en Wireless Workbench y, unos segundos después, la captura.
5. Guárdala como `02-escaneo-470-616-200k.pcapng`.

### Captura 3: otros ajustes

Repite la captura 2 cambiando **una sola cosa** cada vez, para poder comparar:

- `03-escaneo-470-616-1M.pcapng` (mismo rango, paso 1 MHz)
- `04-escaneo-600-700-200k.pcapng` (otro rango, paso 200 kHz)
- `05-escaneo-470-616-25k.pcapng` (paso 25 kHz; tarda más, deja al menos una
  pasada completa)

### Captura 4: cerrar

Con Wireless Workbench conectado y sin escanear, empieza una captura, cierra
Wireless Workbench, espera 10 segundos y para la captura:
`06-cierre.pcapng`.

### Para cada captura, anota

- La hora a la que hiciste cada cosa (empezar, cambiar ajustes, parar).
- Lo que se veía en pantalla: si te es fácil, una captura de pantalla del
  espectro en Wireless Workbench durante el escaneo. Así puedo comprobar que
  decodifico los niveles correctamente (por ejemplo, que un micrófono a
  518,100 MHz aparece donde debe y con el nivel que mostraba WWB).

## Qué hago con ellas

Con esas capturas:

1. Identifico el descubrimiento, la sesión, los mensajes de configuración y el
   formato de los datos.
2. Escribo `Axt600NetworkLink` y un AXT600 falso que responde igual que el real,
   para que los tests sigan funcionando sin el equipo.
3. Te paso una lista de comprobaciones para la primera prueba con el equipo:
   que el escaneo arranca, que los niveles coinciden con WWB, que un cambio de
   rango funciona, y qué pasa si se desconecta el cable a mitad de escaneo.

Las capturas solo contienen tráfico entre tu ordenador y tu equipo, pero
revisa antes de compartirlas que no se haya colado tráfico de otros equipos de
la red que no quieras enseñar.

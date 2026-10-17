# El protocolo del AXT600

Lo que se sabe de cómo habla un Shure AXT600 por la red, obtenido de capturas
de Wireless Workbench escaneando una unidad con **firmware 2.1.41**
(17-10-2026). El driver (`driver/`) implementa exactamente esto, y
`__tests__/acn.test.js` comprueba byte a byte que el plugin produce los mismos
paquetes que Wireless Workbench.

## Resumen

El AXT600 habla **ACN (ANSI E1.17)** estándar: SLP para anunciarse, SDT para
la sesión y DMP para las propiedades. **Sin cifrar y sin clave**: a diferencia
del AD600, no hay derivación de clave ni nada obtenido por ingeniería inversa
del software de Shure. Cualquier implementación de E1.17 puede hablar con él.

| | |
|---|---|
| Anuncio | SLPv2 a `239.255.254.253:8427`, cada ~4 s |
| Sesión | UDP al puerto `57383` del equipo |
| Cifrado | ninguno |
| FTP (`21`) | Wireless Workbench descarga `/ram0/ssm_export.cfl` y `.dev` (listas de frecuencias). El plugin no lo usa |

## Anuncio (SLP)

```
(cid=A1B2C3D4-0000-11DD-A000-000EDDCCCCCC),(acn-fctn=AXT600),(acn-uacn=AXT600),
(acn-services=esta.dmp),
(csl-esta.dmp=esta.sdt/192.168.1.3:57383;esta.dmp/cd:CCC57006-E139-11DF-9451-0015C5F3F612),
(device-description=$:tftp://192.168.1.3/$.ddl),(csl-esta.dmp.values=version:1_interfaceId:48)
```

El CID empieza por los cuatro últimos bytes de la MAC (MAC `00:0e:a1:b2:c3:d4` → CID `A1B2C3D4-…`), seguidos de
un sufijo fijo.

Wireless Workbench se anuncia igual, con su propio CID y `acn-fctn=WWB6`, dos
segundos antes de su primer `JOIN`, y repite el anuncio cada ~4 s. Una unidad
real no contestó al `JOIN` de un controlador que no se había anunciado, así
que el plugin también lo hace. Se anuncia como `acn-fctn=SoundBase`, con su
propio CID y su propio identificador de definición, nunca como Wireless
Workbench.

## Sesión (SDT)

1. Controlador → `JOIN` (su canal, MID 1 para el equipo, parámetros
   expiry 5 s, NAK holdoff 2, modulus 50, max wait 20).
2. Equipo → `JOIN_ACCEPT`, y enseguida su propio `JOIN` hacia el controlador.
3. Controlador → `JOIN_ACCEPT`. Ambos se envían un `ACK` del número de
   secuencia inicial del otro.
4. Controlador → `CONNECT` DMP; equipo → `CONNECT_ACCEPT`. Y al revés.
5. Cada ~1,4 s, un wrapper vacío con MAK = 1 pide un `ACK`. Si el equipo no
   oye nada en 5 s, cierra la sesión.

Los bloques de cliente del controlador llevan como MID el que asignó al equipo
en su `JOIN`; los eventos del equipo van a MID `0xffff`.

## Propiedades (DMP)

Direcciones de 4 bytes. Las cadenas llevan delante un u16 con su longitud
total, contándose a sí mismo.

| Dirección | Qué es | Valor |
|---|---|---|
| `0x01000000`, `0x01000012` | modelo | `"AXT600"` |
| `0x01000002` | (número de serie?) | `"VT000000000"` |
| `0x01000004` | firmware | 4 × u16: `2, 1, 41, 0` |
| `0x0100002b` | tiempo encendido | `"0:15:47"` |
| `0x01010100` | MAC | `00 0e dd …` (6 bytes) |
| `0x01010102` | IP | `c0 a8 01 03` |
| `0x01010103` | máscara | `ff ff 00 00` |
| `0x01070220` | pasos disponibles | `";25;200;1000"` |
| `0x01070221` | (resoluciones?) | `";200;25;1000"` |
| `0x01070201`, `0x01070202` | último inicio y paso | u32 kHz |

### Escaneo

| Dirección | | |
|---|---|---|
| `0x01070100` | inicio, kHz | u32 |
| `0x01070101` | fin, kHz | u32 |
| `0x01070102` | paso, kHz | u32: 25, 200 o 1000 |
| `0x01070108` | resolución, kHz | u32; Wireless Workbench pone el mismo valor que el paso |
| `0x01070109` | (flags) | u8; Wireless Workbench escribe `0xff` |
| `0x01070103` | **empezar** | escribir `0` |
| `0x0107010e` | **parar** | escribir `0` |
| `0x01070110` | progreso | evento, 0–100 % en pasos de 5 |
| `0x01070131` | escaneando | evento, 1 durante el escaneo |
| `0x1fffffff` | suscripción a los datos del escaneo | |
| `0x10000000 + i` | datos | evento de rango: int16 big-endian, décimas de dBm. El primer punto está en **470 MHz + i × 25 kHz**; los siguientes, a un paso de escaneo |

El equipo no responde a un `SET`. Wireless Workbench añade detrás un `GET` de la
dirección 0 (de 1 byte), que el equipo contesta con `GET_FAIL`: esa respuesta
indica que los `SET` anteriores ya se han procesado. El plugin hace lo mismo.

### Cómo llega una pasada

- Ocho módulos de escaneo trabajan en paralelo, cada uno en su bloque de
  frecuencias, y mandan paquetes de hasta 51 puntos.
- **Cada punto llega dos veces**: en la primera mitad de la pasada, y otra vez
  en la segunda mitad. El segundo valor nunca es menor que el primero (en la
  captura, igual 8578 veces y mayor 8304 veces, menor ninguna). Es decir, la
  segunda vuelta trae el máximo de las dos antenas. El plugin se queda con el
  último valor de cada punto y no puede separar las antenas A y B.
- La pasada termina cuando el progreso llega a 100 %. Después empieza otra.
- 470–952 MHz a 25 kHz tardó **62 s** (el datasheet dice 64 s); 470–616 MHz a
  200 kHz, **unos 7 s** por pasada.
- Los módulos empiezan en frecuencias fijas: 470, 518, 578, 638, 698, 740, 790
  y 925 MHz. Por eso el índice de un bloque se cuenta en la rejilla de 25 kHz
  de toda la banda (1920 = 518 MHz) aunque el paso sea otro, y dentro del
  bloque los puntos van a un paso de escaneo.

## Probado con el equipo (17-10-2026, firmware 2.1.41)

Con `npm run probe`:

- El equipo acepta la sesión del plugin: JOIN, CONNECT DMP, lectura del modelo
  y el firmware. Recién encendido tarda en aceptar sesiones aunque ya se
  anuncie; el plugin reintenta.
- Acepta el rango y el paso de 200 kHz, y escanea. Las pasadas terminan al
  100 % y se repiten.
- Con Wireless Workbench abierto, rechaza los ajustes del escaneo con DMP
  *reason 5*: hay que cerrarlo. El plugin para un escaneo en marcha antes de
  escribir y lo explica si aun así se rechazan.
- 470–616 MHz y 500–600 MHz a 200 kHz: pasadas completas, sin huecos, de unos
  7 s. El índice de cada bloque se cuenta en la rejilla de 25 kHz desde
  470 MHz también cuando el escaneo empieza en otra frecuencia.
- Dos sesiones seguidas funcionan.
- **En SoundBase Desktop (v0.1.5): la traza en vivo funciona.**
- **Wi-Fi y cable en la misma subred.** Con el Wi-Fi del Mac también en
  192.168.1.x, macOS mandaba los paquetes hacia el equipo por el Wi-Fi y el
  equipo no los recibía, aunque sus anuncios sí llegaban por el cable. Enlazar
  el socket a la dirección del cable **no basta en macOS**: lo intentamos y
  los paquetes siguieron saliendo por el Wi-Fi. Solución: una subred propia
  para el equipo (por ejemplo 192.168.10.x), apagar el Wi-Fi, o una ruta
  (`sudo route -n add -host <IP> -interface <en…>`). El plugin lo detecta y lo
  explica en el error.

## Lo que falta confirmar

1. **Los pasos de 25 kHz y 1 MHz**, y los tiempos reales de cada uno.
2. **Si hace falta anunciarse por SLP.** El plugin lo hace, como Wireless
   Workbench. No está claro si el equipo lo exige.
3. **865–925 MHz no llegó nunca** en una pasada de 25 kHz de toda la banda.
   Puede ser cosa de la región de la unidad. El plugin rellena ese tramo con el
   suelo de ruido y avisa.
4. **Qué antena es cuál**, y qué significan `0x01070109` y `0x01070108`.

## Volver a capturar

Si algo de lo anterior cambia con otro firmware, con Wireshark en la interfaz
de cable:

1. Captura sin filtro mientras abres Wireless Workbench y aparece el equipo.
2. Captura un escaneo con ajustes que anotes. Antes de guardar, filtra con
   `ip.addr == <IP del AXT600>` y usa *Exportar paquetes especificados → Solo
   los mostrados*.

`__tests__/fixtures/wwb-axt600.json` guarda los paquetes de referencia de la
captura original.

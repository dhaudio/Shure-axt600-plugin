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
un sufijo fijo. El plugin solo escucha: no se anuncia.

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
| `0x10000000 + i` | datos | evento de rango: int16 big-endian, décimas de dBm |

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
- 470–952 MHz a 25 kHz tardó **62 s** (el datasheet dice 64 s).

## Lo que falta confirmar con el equipo

El script `npm run probe -- <IP>` responde a casi todo esto. Antes de
ejecutarlo hay que cerrar Wireless Workbench.

1. **Si el equipo acepta un controlador que no se anuncia por SLP.** Wireless
   Workbench se anuncia dos segundos antes de conectarse; el plugin no.
2. **Pasos de 200 kHz y 1 MHz.** En la captura, Wireless Workbench escaneó a
   25 kHz todo el rango aunque se le pidió 470–616 a 200 kHz. Falta ver que el
   equipo acepta otro paso y cómo numera entonces los puntos: por pasos desde
   el inicio (lo que espera el plugin) o sobre la rejilla de 25 kHz desde
   470 MHz. El plugin detecta lo segundo solo y lo anota en el log.
3. **865–925 MHz no llegó nunca.** En la pasada de 25 kHz, ese tramo no se
   envió y el progreso llegó igualmente al 100 %. Puede ser una restricción de
   la región de la unidad. El plugin lo rellena con el suelo de ruido y avisa.
4. **Exclusividad.** No se sabe si dos controladores pueden escanear a la vez.
   Wireless Workbench no reclama el escáner como hace con el AD600.
5. **Qué antena es cuál**, y el significado de `0x01070109` y `0x01070108`.

## Volver a capturar

Si algo de lo anterior cambia con otro firmware, con Wireshark en la interfaz
de cable:

1. Captura sin filtro mientras abres Wireless Workbench y aparece el equipo.
2. Captura un escaneo con ajustes que anotes. Antes de guardar, filtra con
   `ip.addr == <IP del AXT600>` y usa *Exportar paquetes especificados → Solo
   los mostrados*.

`__tests__/fixtures/wwb-axt600.json` guarda los paquetes de referencia de la
captura original.

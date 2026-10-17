# Shure AXT600 para SoundBase

Plugin de SoundBase que convierte un **Shure AXT600 Axient Spectrum Manager**
en un analizador de espectro en vivo: su escaneo pasa a ser la traza del
gráfico. En cada frecuencia, la traza muestra el nivel más fuerte de las dos
antenas, que es lo que reporta el propio equipo.

Creado a partir de
[soundbase-plugin-template](https://github.com/soundbase-lab/soundbase-plugin-template).

> **Estado: funciona con un AXT600 real (firmware 2.1.41) en SoundBase Desktop, en pruebas.**
> Habla el protocolo del AXT600 tal como se ve en capturas de Wireless
> Workbench con una unidad de firmware 2.1.41: ACN estándar, sin cifrar
> ([docs/protocolo.md](docs/protocolo.md)). Los paquetes que envía son, byte a
> byte, los de Wireless Workbench. Lo siguiente es ejecutar
> `npm run probe` con el equipo ([abajo](#probarlo-con-tu-axt600)).

## Antes de empezar

- **El AXT600 en la misma red (subred) que el ordenador**, por cable, y
  **en una subred distinta de la del Wi-Fi**. Si los dos están en, por
  ejemplo, 192.168.1.x, macOS envía al equipo por el Wi-Fi y no llega. Usa
  otra subred para el equipo (por ejemplo 192.168.10.x) o apaga el Wi-Fi.
- **Wireless Workbench cerrado** mientras el plugin escanea.
- Node.js 20 o superior, para desarrollar y para `npm run probe`.

## Probarlo con tu AXT600

```sh
npm install
npm run probe -- 192.168.1.3
```

El script encuentra el equipo por su anuncio en la red, abre una sesión, lee el
modelo y el firmware, y escanea 470–616 MHz a 200 kHz durante dos pasadas.
Después para y se desconecta. Muestra lo que ocurre y guarda un informe
`probe-axt600-<fecha>.json`. Opciones: `--start 470 --stop 616 --step 200
--passes 2` (MHz, MHz, kHz).

Solo escribe en el equipo lo mismo que Wireless Workbench al pulsar Scan:
el rango, el paso, empezar y parar.

## Probarlo sin el equipo

```sh
npm test                   # contrato, protocolo y driver, sin nada conectado
SB_AXT600_MOCK=1 npm start # un AXT600 simulado, para probarlo con curl
```

Dentro de SoundBase, activa **Simulated AXT600** en los ajustes del plugin.
Los AXT600 reales de la red aparecen solos en el selector de dispositivos. Se
identifican por su ID ACN, no por su IP, así que si le cambias la IP a un
equipo, tus proyectos lo siguen reconociendo.

## Cómo se traducen los ajustes de SoundBase

| Ajuste de SoundBase | Qué hace el AXT600 |
|---|---|
| Frecuencia inicial / final | Escanea ese rango dentro de 470–952 MHz, sobre la rejilla de 25 kHz. El último punto es el último paso que cabe antes de la frecuencia final. |
| RBW | Elige el paso de escaneo: 25 kHz, 200 kHz o 1 MHz (el más cercano a lo pedido). |
| Número de puntos | Sin RBW elegido, decide el paso más fino que cabe en ese número de puntos. |
| Modo de traza | Lo lleva SoundBase, por antena. |

Un escaneo de 25 kHz de todo el rango son 19 281 puntos; la traza se reduce a
un máximo de 2000 tomando el pico de cada grupo, para que ninguna portadora se
pierda entre dos puntos.

Diferencias con otros analizadores:

- **Es lento con pasos finos.** Según el datasheet, hasta 48 s por cada 60 MHz
  a 25 kHz y 64 s para todo el rango. El plugin avisa a SoundBase del tiempo
  esperado, para que no lo tome por un equipo colgado, y muestra un aviso
  mientras se completa la primera pasada.
- **La traza se actualiza una vez por pasada.** Los 8 módulos de escaneo mandan
  sus bloques en paralelo y cada punto llega dos veces (una antena, y después
  el máximo de las dos). La traza se emite cuando el equipo marca el 100 %.
- **Sin curvas por antena.** El AXT600 no indica qué antena es cada lectura,
  así que solo hay una traza.
- **Tramos sin datos.** Si el equipo no reporta parte del rango (en la captura
  de referencia no envió 865–925 MHz), esos puntos muestran el suelo de ruido y
  SoundBase muestra un aviso.

## Estructura

```
adapter.js                  descubrimiento, capacidades, recortar y devolver, avisos
driver/
  acn.js                    ACN: capa raíz, SDT y DMP (codificar y decodificar)
  sdt-session.js            una sesión con el equipo: join, keep-alive, get/set/sub
  slp.js                    escuchar los anuncios de los AXT600 de la red
  axt600-link.js            el AXT600 real: propiedades, escaneo, datos
  link.js                   qué link usa cada dispositivo
  scan-plan.js              qué se puede pedir y qué vuelve
  sweep-assembler.js        bloques de escaneo -> barridos completos
  simulated-axt600.js       un AXT600 simulado, dentro del proceso
  fake-axt600.js            un AXT600 falso por UDP, para los tests
scripts/probe-axt600.mjs    probar el driver con un equipo real
docs/protocolo.md           el protocolo, tal como se ha descifrado
__tests__/                  contrato (HTTP), protocolo (bytes reales) y driver
```

Comprobaciones, en orden:

```sh
npm run doctor      # ¿está bien formado el plugin?
npm test            # todo, sin nada conectado
npm run smoke       # arranca main.js como proceso hijo, como hace SoundBase
```

Variables de entorno, todas opcionales:

| | |
|---|---|
| `SB_AXT600_MOCK=1` | Lista el AXT600 simulado aunque el ajuste del plugin esté desactivado. |
| `SB_AXT600_SIM_TIMESCALE` | Multiplica los tiempos del simulador (1 = tiempo real). |
| `SB_AXT600_SLP_PORT` | Escucha los anuncios en ese puerto de loopback (tests). |

## Siguientes pasos

1. `npm run probe` con el equipo, y ajustar lo que haga falta
   ([lo que falta confirmar](docs/protocolo.md#lo-que-falta-confirmar-con-el-equipo)).
2. Medir los tiempos reales de escaneo a 200 kHz y 1 MHz.
3. Probarlo dentro de SoundBase Desktop.
4. Publicar una release y enviarla al Lab.

La guía de la plantilla está en [docs/](docs/README.md) (en inglés), y
[CLAUDE.md](CLAUDE.md) resume el modelo de plugin.

## Licencia y marcas

La plantilla y `@soundbase/plugin-shell` están bajo la Business Source License
1.1 (ver `LICENSE`). Tu propio código es tuyo.

Sobre cómo habla con el equipo: el plugin usa ACN (ANSI E1.17), un estándar
público. El AXT600 no cifra su sesión, y el plugin no contiene claves ni código
obtenido del software de Shure. No se anuncia como Wireless Workbench. Su
identificador ACN usa el mismo sufijo que los equipos Shure.

Este plugin no está afiliado, autorizado ni respaldado por Shure Incorporated.
"Shure", "AXT600", "Axient" y "Wireless Workbench" son marcas de su titular y se
usan solo para indicar con qué funciona el plugin.

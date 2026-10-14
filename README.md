# Shure AXT600 para SoundBase

Plugin de SoundBase que convierte un **Shure AXT600 Axient Spectrum Manager**
en un analizador de espectro en vivo: su escaneo pasa a ser la traza del
gráfico, con el máximo de las dos antenas como traza principal y las antenas
**A** y **B** como curvas propias.

Creado a partir de
[soundbase-plugin-template](https://github.com/soundbase-lab/soundbase-plugin-template).

> **Estado: funciona con un AXT600 simulado; todavía no habla con uno real.**
> Shure no publica el protocolo de red del AXT600, así que hay que capturarlo
> de tu equipo con Wireshark mientras Wireless Workbench escanea.
> [docs/protocolo.md](docs/protocolo.md) explica cómo hacerlo. Todo lo demás
> (ajustes, ensamblado de barridos, avisos, tests) ya está hecho y no cambiará
> cuando llegue el driver real.

## Probarlo ahora, sin el equipo

```sh
npm install
npm test                   # 39 tests: contrato, plan de escaneo, simulador
SB_AXT600_MOCK=1 npm start # un AXT600 simulado, para probarlo con curl
```

Dentro de SoundBase, activa **Simulated AXT600** en los ajustes del plugin y
aparecerá en el selector de dispositivos. El simulador tarda lo mismo que el
equipo real (unos 9 s por pasada a 200 kHz entre 470 y 616 MHz);
`SB_AXT600_SIM_TIMESCALE=0.1` lo acelera diez veces.

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
- **Los datos llegan por bloques.** Los 8 módulos de escaneo terminan cada uno
  su bloque cuando pueden; la traza se emite cuando las dos antenas han cubierto
  todo el rango.

## Estructura

```
adapter.js                  descubrimiento, capacidades, recortar y devolver, avisos
driver/
  link.js                   la interfaz con el equipo; Axt600NetworkLink, pendiente
  scan-plan.js              qué se puede pedir y qué vuelve (datos del datasheet)
  sweep-assembler.js        bloques de escaneo -> barridos completos
  simulated-axt600.js       un AXT600 simulado: 2 antenas, 8 módulos, tiempos reales
docs/protocolo.md           cómo capturar el protocolo con Wireshark
__tests__/                  tests del contrato (por HTTP) y del driver
```

Comprobaciones, en orden:

```sh
npm run doctor      # ¿está bien formado el plugin?
npm test            # el contrato y el driver, sin nada conectado
npm run smoke       # arranca main.js como proceso hijo, como hace SoundBase
SB_AXT600_MOCK=1 npm run smoke   # igual, recorriendo también el barrido
```

Variables de entorno, todas opcionales:

| | |
|---|---|
| `SB_AXT600_MOCK=1` | Lista el AXT600 simulado aunque el ajuste del plugin esté desactivado. |
| `SB_AXT600_SIM_TIMESCALE` | Multiplica los tiempos del simulador (1 = tiempo real). |

## Siguientes pasos

1. Capturar el protocolo de tu AXT600 ([docs/protocolo.md](docs/protocolo.md)).
2. Escribir `Axt600NetworkLink` a partir de las capturas, con un AXT600 falso
   que responda igual para los tests.
3. Descubrimiento automático en la red, si el equipo se anuncia.
4. Primera prueba con el equipo y medir los tiempos reales de escaneo.
5. Poner tu repositorio en el campo `repository` de `soundbase-plugin.json`.

La guía de la plantilla está en [docs/](docs/README.md) (en inglés), y
[CLAUDE.md](CLAUDE.md) resume el modelo de plugin.

## Licencia y marcas

La plantilla y `@soundbase/plugin-shell` están bajo la Business Source License
1.1 (ver `LICENSE`). Tu propio código es tuyo.

Este plugin no está afiliado, autorizado ni respaldado por Shure Incorporated.
"Shure", "AXT600", "Axient" y "Wireless Workbench" son marcas de su titular y se
usan solo para indicar con qué funciona el plugin.
